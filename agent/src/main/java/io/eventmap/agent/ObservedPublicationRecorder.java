package io.eventmap.agent;

import org.springframework.amqp.core.Correlation;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessagePostProcessor;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Enregistre les triplets {@code (exchange, routingKey, type de payload)} réellement
 * publiés, pour rattraper les routing keys que l'analyse statique ne peut pas résoudre
 * (concaténation, enum, valeur issue de la configuration).
 *
 * <p><b>Ce que ça vaut, et ce que ça ne vaut pas.</b> C'est une preuve d'existence,
 * jamais une preuve d'exhaustivité : un chemin de code jamais emprunté depuis le
 * démarrage du pod reste invisible. Le job marque ces arêtes {@code observed} et les
 * trace en pointillé — ne les traite pas comme des déclarations.
 *
 * <p>Coût : une entrée de map par clé distincte, aucune allocation sur le chemin chaud
 * une fois la clé vue. Le cardinal est borné explicitement pour qu'une routing key
 * contenant un identifiant ne fasse pas gonfler la mémoire indéfiniment.
 */
public class ObservedPublicationRecorder implements MessagePostProcessor {

    private static final String TYPE_HEADER = "__TypeId__";

    private final Map<String, Entry> seen = new ConcurrentHashMap<>();
    private final AtomicLong dropped = new AtomicLong();
    private final int maxCardinality;

    public ObservedPublicationRecorder(int maxCardinality) {
        this.maxCardinality = maxCardinality;
    }

    @Override
    public Message postProcessMessage(Message message) {
        // Surcharge sans contexte de routage : rien d'exploitable, on laisse passer.
        return message;
    }

    /**
     * Surcharge porteuse de l'exchange et de la routing key, appelée par
     * {@code RabbitTemplate.doSend}. Requiert Spring AMQP 2.3+.
     */
    @Override
    public Message postProcessMessage(Message message, Correlation correlation, String exchange, String routingKey) {
        if (routingKey == null || routingKey.isEmpty()) {
            return message;
        }
        String key = exchange + '|' + routingKey;
        Entry entry = seen.get(key);
        if (entry != null) {
            entry.count.incrementAndGet();
            return message;
        }
        if (seen.size() >= maxCardinality) {
            dropped.incrementAndGet();
            return message;
        }
        Object type = message.getMessageProperties() != null
                ? message.getMessageProperties().getHeader(TYPE_HEADER)
                : null;
        seen.putIfAbsent(key, new Entry(exchange, routingKey, type == null ? null : type.toString()));
        return message;
    }

    public List<Map<String, Object>> snapshot() {
        List<Map<String, Object>> out = new ArrayList<>(seen.size());
        for (Entry e : seen.values()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("exchange", e.exchange);
            m.put("routingKey", e.routingKey);
            if (e.payload != null) {
                m.put("payload", e.payload);
            }
            m.put("count", e.count.get());
            out.add(m);
        }
        return out;
    }

    /** Nombre de publications ignorées après saturation — signale une clé à haute cardinalité. */
    public long droppedCount() {
        return dropped.get();
    }

    private static final class Entry {
        final String exchange;
        final String routingKey;
        final String payload;
        final AtomicLong count = new AtomicLong(1);

        Entry(String exchange, String routingKey, String payload) {
            this.exchange = exchange;
            this.routingKey = routingKey;
            this.payload = payload;
        }
    }
}
