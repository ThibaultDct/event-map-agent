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
 * <p><b>Sur une méthode</b>, quand celle-ci publie un message précis :
 *
 * <pre>{@code
 * @PublishesEvent(routingKey = "evt.order.created", payload = OrderCreatedEvent.class)
 * public void publishOrderCreated(Order order) {
 *     rabbitTemplate.convertAndSend(EXCHANGE, "evt.order.created", toEvent(order));
 * }
 * }</pre>
 *
 * <p><b>Sur la classe d'événement</b>, quand la publication passe par une façade
 * générique. Une méthode {@code <T extends InstructionDto> void publish(FxEvent<T>)}
 * émet des dizaines de messages différents : y poser l'annotation figerait une seule
 * clé pour tous. La connaissance « quelle clé, quel payload » appartient à
 * l'événement, pas au transport :
 *
 * <pre>{@code
 * @PublishesEvent(routingKey = "evt.fx.trade.executed")
 * public class FxTradeExecuted extends FxEvent<FxInstructionDto> { ... }
 * }</pre>
 *
 * Sur une classe, {@link #payload()} vaut par défaut la classe annotée elle-même,
 * et les variables de type des parents génériques sont résolues : le schéma de
 * l'exemple ci-dessus contiendra {@code instruction : FxInstructionDto}, pas
 * {@code instruction : T}.
 *
 * <p><b>Attention à l'attribution.</b> Le manifeste est produit dans le jar où se
 * trouve la classe annotée, et le service fusionne tous les manifestes de son
 * classpath. Si vos classes d'événements vivent dans un module de contrats
 * partagé par plusieurs services, chacun se déclarera producteur de tout.
 * Dans ce cas, annotez plutôt le point d'appel, dans le service émetteur.
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

    /**
     * Routing key concrète émise. Ne doit contenir ni {@code *} ni {@code #}.
     *
     * <p>Facultative sur une classe : laissée vide, elle est <b>calculée</b> selon
     * la convention {@code evt.<application>.<NomDeClasse>} pour un événement et
     * {@code cmd.<cible>.<NomDeClasse>} pour une commande. Obligatoire en revanche
     * sur une méthode, où rien ne permet de la déduire.
     */
    String routingKey() default "";

    /**
     * Worker destinataire, pour une commande.
     *
     * <p>Une commande est <em>adressée</em> : contrairement à un événement, dont
     * l'origine est le service émetteur lui-même, la cible ne figure nulle part
     * dans le code et doit être déclarée. C'est la seule information que la
     * convention ne peut pas déduire.
     */
    String target() default "";

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
