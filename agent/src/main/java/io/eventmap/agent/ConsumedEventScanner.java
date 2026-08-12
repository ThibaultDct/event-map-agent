package io.eventmap.agent;

import javax.annotation.processing.ProcessingEnvironment;
import javax.lang.model.element.AnnotationMirror;
import javax.lang.model.element.AnnotationValue;
import javax.lang.model.element.Element;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.TypeMirror;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Repère les {@code @RabbitListener} et extrait le type que chaque handler
 * <em>attend</em> réellement.
 *
 * <p>C'est la moitié manquante du contrat. Sans elle, le job compare un payload
 * à sa propre version passée — il détecte qu'un producteur a changé, mais pas
 * qu'il a divergé de ce que ses consommateurs savent lire. Or ce défaut-là ne
 * se voit qu'en production : aucun test unitaire ne franchit la frontière entre
 * deux services.
 *
 * <p>L'extraction se fait à la compilation, comme pour les producteurs, ce qui
 * permet de réutiliser {@link SchemaExtractor} tel quel — y compris sa résolution
 * des variables de type, indispensable dès que les enveloppes sont génériques.
 * Une extraction par réflexion au runtime devrait tout réécrire contre
 * {@code java.lang.reflect.Type} et se heurterait à l'effacement.
 */
final class ConsumedEventScanner {

    private static final String RABBIT_LISTENER = "org.springframework.amqp.rabbit.annotation.RabbitListener";
    private static final String PAYLOAD = "org.springframework.messaging.handler.annotation.Payload";

    /** Paramètres techniques d'un handler : jamais le corps du message. */
    private static final Set<String> TECHNICAL = Set.of(
            "org.springframework.amqp.core.Message",
            "org.springframework.messaging.Message",
            "com.rabbitmq.client.Channel",
            "org.springframework.messaging.MessageHeaders",
            "org.springframework.amqp.rabbit.listener.api.ChannelAwareMessageListener",
            "java.util.Map");

    /** Annotations qui marquent un paramètre comme n'étant pas le corps. */
    private static final Set<String> NOT_PAYLOAD = Set.of("Header", "Headers");

    private final ProcessingEnvironment env;

    ConsumedEventScanner(ProcessingEnvironment env) {
        this.env = env;
    }

    /** Une attente de consommateur : quelles queues, quel type, quelle structure. */
    record Expectation(List<String> queues, String payload, String handler, List<SchemaExtractor.Field> schema) { }

    List<Expectation> scan(TypeElement type) {
        List<Expectation> out = new ArrayList<>();
        for (Element member : type.getEnclosedElements()) {
            if (!(member instanceof ExecutableElement method)) {
                continue;
            }
            AnnotationMirror listener = annotation(method, RABBIT_LISTENER);
            if (listener == null) {
                continue;
            }
            VariableElement body = payloadParameter(method);
            if (body == null) {
                // Handler purement technique (Message brut, en-têtes seuls) :
                // il n'y a pas de contrat de structure à comparer.
                continue;
            }
            TypeMirror payloadType = body.asType();
            out.add(new Expectation(
                    queuesOf(listener),
                    env.getTypeUtils().erasure(payloadType).toString(),
                    type.getQualifiedName() + "#" + method.getSimpleName(),
                    new SchemaExtractor(env).extract(payloadType)));
        }
        return out;
    }

    /**
     * Le paramètre porteur du corps du message.
     *
     * <p>{@code @Payload} tranche quand il est présent. Sinon on prend le premier
     * paramètre qui n'est ni un type d'infrastructure ni un en-tête — c'est la
     * même règle que celle qu'applique Spring AMQP pour lier ses arguments.
     */
    private VariableElement payloadParameter(ExecutableElement method) {
        for (VariableElement p : method.getParameters()) {
            if (annotation(p, PAYLOAD) != null) {
                return p;
            }
        }
        for (VariableElement p : method.getParameters()) {
            if (hasAnySimpleAnnotation(p, NOT_PAYLOAD)) {
                continue;
            }
            String fqn = env.getTypeUtils().erasure(p.asType()).toString();
            if (TECHNICAL.contains(fqn)) {
                continue;
            }
            return p;
        }
        return null;
    }

    private List<String> queuesOf(AnnotationMirror listener) {
        List<String> out = new ArrayList<>();
        // `queues` couvre le cas courant. `bindings = @QueueBinding(...)` déclare
        // la queue dans une annotation imbriquée : le nom y est souvent généré,
        // et le manifeste runtime le rattrapera via `listening`.
        for (String attr : List.of("queues", "queuesToDeclare")) {
            for (AnnotationValue v : arrayAttribute(listener, attr)) {
                Object raw = v.getValue();
                if (raw != null && !raw.toString().isBlank()) {
                    out.add(raw.toString());
                }
            }
        }
        return out;
    }

    private List<AnnotationValue> arrayAttribute(AnnotationMirror mirror, String name) {
        for (Map.Entry<? extends ExecutableElement, ? extends AnnotationValue> e
                : env.getElementUtils().getElementValuesWithDefaults(mirror).entrySet()) {
            if (!e.getKey().getSimpleName().contentEquals(name)) {
                continue;
            }
            Object value = e.getValue().getValue();
            if (value instanceof List<?> list) {
                List<AnnotationValue> out = new ArrayList<>();
                for (Object o : list) {
                    if (o instanceof AnnotationValue av) {
                        out.add(av);
                    }
                }
                return out;
            }
        }
        return List.of();
    }

    private AnnotationMirror annotation(Element el, String fqn) {
        for (AnnotationMirror am : el.getAnnotationMirrors()) {
            Element declaration = am.getAnnotationType().asElement();
            if (declaration instanceof TypeElement te && te.getQualifiedName().contentEquals(fqn)) {
                return am;
            }
        }
        return null;
    }

    private boolean hasAnySimpleAnnotation(Element el, Set<String> simpleNames) {
        for (AnnotationMirror am : el.getAnnotationMirrors()) {
            if (simpleNames.contains(am.getAnnotationType().asElement().getSimpleName().toString())) {
                return true;
            }
        }
        return false;
    }
}
