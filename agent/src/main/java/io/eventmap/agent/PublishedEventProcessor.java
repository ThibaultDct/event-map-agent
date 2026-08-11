package io.eventmap.agent;

import javax.annotation.processing.AbstractProcessor;
import javax.annotation.processing.Filer;
import javax.annotation.processing.RoundEnvironment;
import javax.annotation.processing.SupportedAnnotationTypes;
import javax.lang.model.SourceVersion;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
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
 * Produit {@code META-INF/event-publishers.json} à partir des {@link PublishesEvent}
 * trouvées à la compilation.
 *
 * <p>Le manifeste est ainsi <em>baké dans le jar</em> : il ne peut pas dériver du
 * code, contrairement à un fichier maintenu à la main. Le processeur est déclaré
 * dans {@code META-INF/services}, donc javac le découvre tout seul dès que l'agent
 * est sur le classpath de compilation — aucune configuration Maven côté service.
 */
@SupportedAnnotationTypes({
        "io.eventmap.agent.PublishesEvent",
        "io.eventmap.agent.PublishesEvents"
})
public class PublishedEventProcessor extends AbstractProcessor {

    private static final String OUTPUT = "META-INF/event-publishers.json";

    /**
     * Déclaré dynamiquement plutôt que par {@code @SupportedSourceVersion} : une
     * valeur figée ferait émettre à javac un avertissement « supported source
     * version less than -source » à chaque compilation de chaque service dès que
     * le JDK avance. Le processeur ne lit que des annotations, il est indifférent
     * à la version du langage.
     */
    @Override
    public SourceVersion getSupportedSourceVersion() {
        return SourceVersion.latestSupported();
    }

    /** Accumulé sur tous les rounds : on n'écrit qu'à la toute fin. */
    private final List<String> entries = new ArrayList<>();

    @Override
    public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment roundEnv) {
        Set<Element> annotated = new LinkedHashSet<>();
        annotated.addAll(roundEnv.getElementsAnnotatedWith(PublishesEvent.class));
        // Une annotation répétée est portée par son conteneur, pas par l'annotation
        // elle-même : sans cette seconde passe, les méthodes qui publient plusieurs
        // événements seraient silencieusement ignorées.
        annotated.addAll(roundEnv.getElementsAnnotatedWith(PublishesEvents.class));

        for (Element element : annotated) {
            for (PublishesEvent a : element.getAnnotationsByType(PublishesEvent.class)) {
                if (a.routingKey().isBlank()) {
                    processingEnv.getMessager().printMessage(
                            Diagnostic.Kind.ERROR, "@PublishesEvent exige une routingKey non vide", element);
                    continue;
                }
                if (a.routingKey().contains("*") || a.routingKey().contains("#")) {
                    processingEnv.getMessager().printMessage(
                            Diagnostic.Kind.WARNING,
                            "@PublishesEvent.routingKey contient un joker AMQP : une publication "
                                    + "porte une clé concrète, pas un pattern de binding.", element);
                }
                entries.add(toJson(a, element));
            }
        }

        if (roundEnv.processingOver()) {
            write();
        }
        // false : on ne « consomme » pas les annotations, d'autres processeurs
        // (Lombok, MapStruct…) doivent pouvoir les voir aussi.
        return false;
    }

    private String toJson(PublishesEvent a, Element element) {
        StringBuilder sb = new StringBuilder("    {");
        sb.append("\"routingKey\":").append(quote(a.routingKey()));
        if (!a.exchange().isBlank()) {
            sb.append(",\"exchange\":").append(quote(a.exchange()));
        }
        TypeMirror payloadType = payloadTypeOf(a);
        String payload = payloadType == null ? null : payloadType.toString();
        if (payload != null) {
            sb.append(",\"payload\":").append(quote(payload));
        }
        if (!a.kind().isBlank()) {
            sb.append(",\"kind\":").append(quote(a.kind()));
        }
        sb.append(",\"source\":").append(quote(describe(element)));

        // Le schéma aplati du payload : c'est lui qui permettra au job de
        // détecter une rupture de contrat entre deux scans.
        if (payloadType != null) {
            List<SchemaExtractor.Field> fields = new SchemaExtractor(processingEnv).extract(payloadType);
            if (!fields.isEmpty()) {
                StringJoiner j = new StringJoiner(",", "[", "]");
                for (SchemaExtractor.Field f : fields) {
                    j.add("{\"path\":" + quote(f.path()) + ",\"type\":" + quote(f.type()) + "}");
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
    private TypeMirror payloadTypeOf(PublishesEvent a) {
        TypeMirror mirror;
        try {
            Class<?> c = a.payload();
            mirror = processingEnv.getElementUtils().getTypeElement(c.getCanonicalName()).asType();
        } catch (MirroredTypeException e) {
            mirror = e.getTypeMirror();
        }
        if (mirror == null) {
            return null;
        }
        String name = mirror.toString();
        return "java.lang.Void".equals(name) || "void".equals(name) ? null : mirror;
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
            Element owner = element.getEnclosingElement();
            return owner + "#" + element.getSimpleName();
        }
        return element.toString();
    }

    private void write() {
        if (entries.isEmpty()) {
            return;
        }
        try {
            Filer filer = processingEnv.getFiler();
            FileObject file = filer.createResource(StandardLocation.CLASS_OUTPUT, "", OUTPUT);
            try (Writer w = file.openWriter()) {
                w.write("[\n");
                w.write(String.join(",\n", entries));
                w.write("\n]\n");
            }
            processingEnv.getMessager().printMessage(
                    Diagnostic.Kind.NOTE, "event-map : " + entries.size() + " publication(s) écrite(s) dans " + OUTPUT);
        } catch (IOException e) {
            processingEnv.getMessager().printMessage(
                    Diagnostic.Kind.WARNING, "event-map : écriture de " + OUTPUT + " impossible — " + e.getMessage());
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
