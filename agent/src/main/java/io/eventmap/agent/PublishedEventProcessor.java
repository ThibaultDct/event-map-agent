package io.eventmap.agent;

import javax.annotation.processing.AbstractProcessor;
import javax.annotation.processing.Filer;
import javax.annotation.processing.RoundEnvironment;
import javax.annotation.processing.SupportedAnnotationTypes;
import javax.annotation.processing.SupportedOptions;
import javax.lang.model.SourceVersion;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.MirroredTypeException;
import javax.lang.model.type.TypeMirror;
import javax.tools.Diagnostic;
import javax.tools.FileObject;
import javax.tools.StandardLocation;
import java.io.IOException;
import java.io.Writer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.StringJoiner;

/**
 * Produit {@code META-INF/event-publishers.json} à la compilation.
 *
 * <p>Deux sources, dans cet ordre de priorité :
 *
 * <ol>
 *   <li>les éléments portant {@link PublishesEvent} — la déclaration explicite
 *       l'emporte toujours ;</li>
 *   <li>toute classe héritant d'un <b>type de base</b> configuré, dont la routing
 *       key est alors calculée par convention.</li>
 * </ol>
 *
 * <p>Le second mode est celui qui permet de ne rien déclarer. Les types de base
 * se donnent en options de compilation :
 *
 * <pre>{@code
 * <compilerArgs>
 *   <arg>-Aeventmap.eventBase=com.acme.stack.FxEvent</arg>
 *   <arg>-Aeventmap.commandBase=com.acme.stack.Command</arg>
 * </compilerArgs>
 * }</pre>
 *
 * <p><b>Convention.</b> Un événement donne {@code evt.<application>.<NomDeClasse>},
 * une commande {@code cmd.<cible>.<NomDeClasse>}. Le nom de l'application n'est
 * pas connu du compilateur : le manifeste conserve le marqueur
 * {@value #APPLICATION_PLACEHOLDER}, que {@link EventManifestProvider} substitue
 * au runtime par {@code spring.application.name}. C'est plus fiable que de passer
 * l'artifactId Maven, qui n'est pas toujours le nom applicatif.
 */
@SupportedAnnotationTypes("*")
@SupportedOptions({ PublishedEventProcessor.OPT_EVENT_BASE, PublishedEventProcessor.OPT_COMMAND_BASE })
public class PublishedEventProcessor extends AbstractProcessor {

    static final String OPT_EVENT_BASE = "eventmap.eventBase";
    static final String OPT_COMMAND_BASE = "eventmap.commandBase";

    /** Résolu au runtime, le compilateur ne connaît pas le nom de l'application. */
    static final String APPLICATION_PLACEHOLDER = "{application}";

    private static final String OUTPUT = "META-INF/event-publishers.json";
    private static final String OUTPUT_CONSUMERS = "META-INF/event-consumers.json";

    /** Accumulé sur tous les rounds : on n'écrit qu'à la toute fin. */
    private final List<String> entries = new ArrayList<>();
    /** Attentes des {@code @RabbitListener} : la moitié consommateur du contrat. */
    private final List<String> consumerEntries = new ArrayList<>();
    /** Évite d'émettre deux fois une classe vue à la fois annotée et par supertype. */
    private final Set<String> emitted = new LinkedHashSet<>();
    /** N'avertir qu'une fois par type de base introuvable, pas une fois par round. */
    private final Set<String> warnedMissingBase = new LinkedHashSet<>();

    /**
     * Re-résolus à chaque round : un {@code TypeMirror} conservé d'un round à
     * l'autre peut devenir obsolète si d'autres processeurs génèrent du code.
     */
    private List<TypeMirror> eventBases = List.of();
    private List<TypeMirror> commandBases = List.of();

    /**
     * Déclaré dynamiquement plutôt que par {@code @SupportedSourceVersion} : une
     * valeur figée ferait émettre à javac un avertissement « supported source
     * version less than -source » à chaque compilation de chaque service dès que
     * le JDK avance.
     */
    @Override
    public SourceVersion getSupportedSourceVersion() {
        return SourceVersion.latestSupported();
    }

    @Override
    public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment roundEnv) {
        eventBases = bases(OPT_EVENT_BASE);
        commandBases = bases(OPT_COMMAND_BASE);

        processAnnotated(roundEnv);
        processBySupertype(roundEnv);
        processListeners(roundEnv);

        if (roundEnv.processingOver()) {
            write();
        }
        // false : on ne « consomme » pas les annotations, d'autres processeurs
        // (Lombok, MapStruct…) doivent pouvoir les voir aussi.
        return false;
    }

    // ------------------------------------------------------------ déclarations

    private void processAnnotated(RoundEnvironment roundEnv) {
        Set<Element> annotated = new LinkedHashSet<>();
        annotated.addAll(roundEnv.getElementsAnnotatedWith(PublishesEvent.class));
        // Une annotation répétée est portée par son conteneur, pas par l'annotation
        // elle-même : sans cette seconde passe, les méthodes qui publient plusieurs
        // événements seraient silencieusement ignorées.
        annotated.addAll(roundEnv.getElementsAnnotatedWith(PublishesEvents.class));

        for (Element element : annotated) {
            for (PublishesEvent a : element.getAnnotationsByType(PublishesEvent.class)) {
                emit(element, a);
            }
        }
    }

    /**
     * Nature déduite des supertypes. Utilisée aussi bien par le balayage par
     * convention que par le chemin annoté : une commande annotée pour sa seule
     * cible doit rester reconnue comme commande.
     */
    private String inferKind(Element element) {
        if (!(element instanceof TypeElement te)) {
            return null;
        }
        boolean isEvent = isAssignableToAny(te, eventBases);
        boolean isCommand = isAssignableToAny(te, commandBases);
        if (isEvent && isCommand) {
            warn(te, "hérite à la fois d'un type d'événement et d'un type de commande — ignorée");
            return null;
        }
        return isEvent ? "event" : isCommand ? "command" : null;
    }

    // ---------------------------------------------------------- par convention

    private void processBySupertype(RoundEnvironment roundEnv) {
        if (eventBases.isEmpty() && commandBases.isEmpty()) {
            return;
        }
        for (Element root : roundEnv.getRootElements()) {
            for (TypeElement te : collectTypes(root)) {
                // Les classes de base et les enveloppes intermédiaires ne sont pas
                // des messages : seules les classes instanciables le sont.
                if (te.getModifiers().contains(Modifier.ABSTRACT) || te.getKind() != ElementKind.CLASS) {
                    continue;
                }
                if (inferKind(te) == null) {
                    continue;
                }
                emit(te, te.getAnnotation(PublishesEvent.class));
            }
        }
    }

    /** Les classes imbriquées comptent aussi : un fichier peut en déclarer plusieurs. */
    private List<TypeElement> collectTypes(Element root) {
        List<TypeElement> out = new ArrayList<>();
        if (root instanceof TypeElement te) {
            out.add(te);
            for (Element nested : te.getEnclosedElements()) {
                if (nested instanceof TypeElement) {
                    out.addAll(collectTypes(nested));
                }
            }
        }
        return out;
    }

    private List<TypeMirror> bases(String option) {
        String raw = processingEnv.getOptions().get(option);
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        List<TypeMirror> out = new ArrayList<>();
        for (String fqn : raw.split(",")) {
            String name = fqn.trim();
            if (name.isEmpty()) {
                continue;
            }
            TypeElement te = processingEnv.getElementUtils().getTypeElement(name);
            if (te == null) {
                if (warnedMissingBase.add(name)) {
                    processingEnv.getMessager().printMessage(Diagnostic.Kind.WARNING,
                            "event-map : type de base introuvable sur le classpath — " + name);
                }
                continue;
            }
            out.add(processingEnv.getTypeUtils().erasure(te.asType()));
        }
        return out;
    }

    private boolean isAssignableToAny(TypeElement te, List<TypeMirror> bases) {
        TypeMirror self = processingEnv.getTypeUtils().erasure(te.asType());
        for (TypeMirror base : bases) {
            if (processingEnv.getTypeUtils().isAssignable(self, base)) {
                return true;
            }
        }
        return false;
    }

    // ----------------------------------------------------------- consommateurs

    private void processListeners(RoundEnvironment roundEnv) {
        ConsumedEventScanner scanner = new ConsumedEventScanner(processingEnv);
        for (Element root : roundEnv.getRootElements()) {
            for (TypeElement te : collectTypes(root)) {
                for (ConsumedEventScanner.Expectation e : scanner.scan(te)) {
                    if (!emitted.add("listener|" + e.handler())) {
                        continue;
                    }
                    consumerEntries.add(consumerJson(e));
                }
            }
        }
    }

    private String consumerJson(ConsumedEventScanner.Expectation e) {
        StringJoiner queues = new StringJoiner(",", "[", "]");
        e.queues().forEach(q -> queues.add(quote(q)));

        StringBuilder sb = new StringBuilder("    {");
        sb.append("\"handler\":").append(quote(e.handler()));
        sb.append(",\"payload\":").append(quote(e.payload()));
        sb.append(",\"queues\":").append(queues);
        if (!e.schema().isEmpty()) {
            StringJoiner j = new StringJoiner(",", "[", "]");
            for (SchemaExtractor.Field f : e.schema()) {
                j.add("{\"path\":" + quote(f.path()) + ",\"type\":" + quote(f.type())
                        + (f.bound() ? ",\"bound\":true" : "") + "}");
            }
            sb.append(",\"schema\":").append(j);
        }
        return sb.append("}").toString();
    }

    // ------------------------------------------------------------------ commun

    /** @param a annotation portée par l'élément, ou {@code null} */
    private void emit(Element element, PublishesEvent a) {
        String id = element.toString();
        if (!emitted.add(id + "|" + (a == null ? "" : a.routingKey() + a.target()))) {
            return;
        }

        String kind = a != null && !a.kind().isBlank() ? a.kind() : inferKind(element);
        String routingKey = a != null ? a.routingKey() : "";

        if (routingKey.isBlank()) {
            routingKey = derive(element, kind, a);
            if (routingKey == null) {
                return;
            }
        }
        if (routingKey.contains("*") || routingKey.contains("#")) {
            warn(element, "@PublishesEvent.routingKey contient un joker AMQP : une publication "
                    + "porte une clé concrète, pas un pattern de binding.");
        }

        TypeMirror payloadType = payloadTypeOf(a, element);
        entries.add(toJson(routingKey, kind, a, payloadType, element));
    }

    /** Applique la convention. Renvoie {@code null} si la clé ne peut pas être formée. */
    private String derive(Element element, String kind, PublishesEvent a) {
        if (!(element instanceof TypeElement te)) {
            error(element, "@PublishesEvent sur une méthode exige une routingKey explicite : "
                    + "rien ne permet de la déduire d'une signature.");
            return null;
        }
        String simple = te.getSimpleName().toString();
        if ("command".equals(kind)) {
            String target = a == null ? "" : a.target();
            if (target.isBlank()) {
                error(te, "commande sans destinataire : ajoutez @PublishesEvent(target = \"<worker-cible>\"). "
                        + "Une commande est adressée, sa cible ne peut pas être déduite du code.");
                return null;
            }
            return "cmd." + target + "." + simple;
        }
        if ("event".equals(kind)) {
            if (a != null && !a.target().isBlank()) {
                warn(te, "target est ignoré sur un événement : son origine est l'application émettrice.");
            }
            return "evt." + APPLICATION_PLACEHOLDER + "." + simple;
        }
        error(element, "nature du message inconnue : précisez kind = \"event\" ou \"command\", "
                + "ou faites hériter la classe d'un type de base déclaré via -A" + OPT_EVENT_BASE + ".");
        return null;
    }

    private String toJson(String routingKey, String kind, PublishesEvent a, TypeMirror payloadType, Element element) {
        StringBuilder sb = new StringBuilder("    {");
        sb.append("\"routingKey\":").append(quote(routingKey));
        if (a != null && !a.exchange().isBlank()) {
            sb.append(",\"exchange\":").append(quote(a.exchange()));
        }
        if (payloadType != null) {
            // Effacement des paramètres de type : `GenericEvent<T>` s'affiche
            // `GenericEvent`. Les arguments réels, quand ils existent, sont déjà
            // portés par les entrées du schéma.
            String name = processingEnv.getTypeUtils().erasure(payloadType).toString();
            sb.append(",\"payload\":").append(quote(name));
        }
        if (kind != null && !kind.isBlank()) {
            sb.append(",\"kind\":").append(quote(kind));
        }
        sb.append(",\"source\":").append(quote(describe(element)));

        // Le schéma aplati du payload : c'est lui qui permettra au job de
        // détecter une rupture de contrat entre deux scans.
        if (payloadType != null) {
            List<SchemaExtractor.Field> fields = new SchemaExtractor(processingEnv).extract(payloadType);
            if (!fields.isEmpty()) {
                StringJoiner j = new StringJoiner(",", "[", "]");
                for (SchemaExtractor.Field f : fields) {
                    j.add("{\"path\":" + quote(f.path()) + ",\"type\":" + quote(f.type())
                            + (f.bound() ? ",\"bound\":true" : "") + "}");
                }
                sb.append(",\"schema\":").append(j);
            }
        }
        return sb.append("}").toString();
    }

    /**
     * Accéder à {@code payload()} depuis un processeur lève systématiquement une
     * {@link MirroredTypeException} : la classe n'est pas encore chargeable, seul
     * son {@code TypeMirror} existe. C'est précisément ce dont on a besoin pour
     * en extraire le schéma.
     */
    private TypeMirror payloadTypeOf(PublishesEvent a, Element element) {
        TypeMirror mirror = null;
        if (a != null) {
            try {
                Class<?> c = a.payload();
                TypeElement te = processingEnv.getElementUtils().getTypeElement(c.getCanonicalName());
                mirror = te == null ? null : te.asType();
            } catch (MirroredTypeException e) {
                mirror = e.getTypeMirror();
            }
        }
        boolean unset = mirror == null
                || "java.lang.Void".equals(mirror.toString())
                || "void".equals(mirror.toString());
        if (!unset) {
            return mirror;
        }
        // Classe d'événement : le payload, c'est elle. L'exiger en plus
        // (`payload = OrderCreated.class` sur OrderCreated) serait une redite que
        // rien ne garantit cohérente.
        if (element instanceof TypeElement te) {
            return te.asType();
        }
        return null;
    }

    /**
     * Localisation lisible, du type {@code com.acme.OrderService#publishCreated}.
     *
     * <p>On s'arrête au nom qualifié plutôt qu'au numéro de ligne : obtenir une
     * ligne exige l'API {@code com.sun.source.util.Trees}, non portable et fermée
     * sous le système de modules. Le nom qualifié suffit pour naviguer.
     */
    private String describe(Element element) {
        if (element.getKind() == ElementKind.METHOD) {
            return element.getEnclosingElement() + "#" + element.getSimpleName();
        }
        return element.toString();
    }

    private void warn(Element el, String msg) {
        processingEnv.getMessager().printMessage(Diagnostic.Kind.WARNING, "event-map : " + msg, el);
    }

    private void error(Element el, String msg) {
        processingEnv.getMessager().printMessage(Diagnostic.Kind.ERROR, "event-map : " + msg, el);
    }

    private void write() {
        writeJsonArray(OUTPUT, entries, "publication(s)");
        writeJsonArray(OUTPUT_CONSUMERS, consumerEntries, "attente(s) de consommateur");
        // On journalise même à vide : « rien ne se passe » doit rester
        // distinguable de « le processeur n'a pas tourné ».
        if (entries.isEmpty() && consumerEntries.isEmpty()) {
            processingEnv.getMessager().printMessage(Diagnostic.Kind.NOTE,
                    "event-map : ni publication ni @RabbitListener détecté dans ce module.");
        }
    }

    private void writeJsonArray(String path, List<String> items, String label) {
        if (items.isEmpty()) {
            return;
        }
        try {
            Filer filer = processingEnv.getFiler();
            FileObject file = filer.createResource(StandardLocation.CLASS_OUTPUT, "", path);
            try (Writer w = file.openWriter()) {
                w.write("[\n");
                w.write(String.join(",\n", items));
                w.write("\n]\n");
            }
            processingEnv.getMessager().printMessage(Diagnostic.Kind.NOTE,
                    "event-map : " + items.size() + " " + label + " écrite(s) dans " + path);
        } catch (IOException e) {
            processingEnv.getMessager().printMessage(Diagnostic.Kind.WARNING,
                    "event-map : écriture de " + path + " impossible — " + e.getMessage());
        }
    }

    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.append('"').toString();
    }
}
