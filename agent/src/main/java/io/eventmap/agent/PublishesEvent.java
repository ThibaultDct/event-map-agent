package io.eventmap.agent;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Repeatable;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Déclare qu'une méthode (ou une classe) publie un message sur RabbitMQ.
 *
 * <p>C'est le seul point où l'on demande un effort au développeur, et il est
 * délibérément minuscule : le broker sait qui <em>consomme</em>, mais rien ne
 * permet de savoir qui <em>publie</em> sans que quelqu'un le dise. Une heuristique
 * sur les appels {@code convertAndSend} plafonne vers 85 % de justesse dès que les
 * routing keys sont construites dynamiquement ; cette annotation monte à 100 %
 * pour le coût d'une ligne.
 *
 * <pre>{@code
 * @PublishesEvent(routingKey = "evt.order.created", payload = OrderCreatedEvent.class)
 * public void publishOrderCreated(Order order) {
 *     rabbitTemplate.convertAndSend(EXCHANGE, "evt.order.created", toEvent(order));
 * }
 * }</pre>
 *
 * <p>L'annotation est lue à la <em>compilation</em> par {@link PublishedEventProcessor},
 * qui produit {@code META-INF/event-publishers.json} dans le jar. Elle est conservée
 * au runtime pour rester inspectable, mais rien ne la lit à l'exécution.
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target({ ElementType.METHOD, ElementType.TYPE })
@Repeatable(PublishesEvents.class)
public @interface PublishesEvent {

    /** Routing key concrète émise. Ne doit contenir ni {@code *} ni {@code #}. */
    String routingKey();

    /** Type du corps du message. {@code Void} signifie « non précisé ». */
    Class<?> payload() default Void.class;

    /**
     * Exchange visé. Laisser vide si le système n'a qu'un seul exchange topic :
     * le job de découverte le déduira.
     */
    String exchange() default "";

    /**
     * Nature du message. Vide = déduit de la convention de nommage de la routing
     * key ({@code evt.} / {@code cmd.}).
     */
    String kind() default "";
}
