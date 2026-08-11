package io.eventmap.agent;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.amqp.core.Binding;
import org.springframework.amqp.rabbit.listener.AbstractMessageListenerContainer;
import org.springframework.amqp.rabbit.listener.MessageListenerContainer;
import org.springframework.amqp.rabbit.listener.RabbitListenerEndpointRegistry;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Construit le manifeste du service, indépendamment de la façon dont il sera servi.
 *
 * <p>Cette séparation existe parce qu'un worker AMQP n'est pas forcément une
 * application web : sans {@code spring-boot-starter-web}, il n'y a ni servlet ni
 * port HTTP, et un {@code @RestController} n'est tout simplement jamais
 * instancié. Or un système événementiel est le plus souvent composé
 * majoritairement de workers — les exclure viderait la moitié producteur de la
 * carte. La logique vit donc ici, et {@link EventManifestEndpoint} comme
 * {@link StandaloneManifestServer} ne sont que deux transports.
 */
public class EventManifestProvider {

    private static final String MANIFEST_PATTERN = "classpath*:META-INF/event-publishers.json";

    private final ObjectProvider<Binding> bindings;
    private final ObjectProvider<RabbitListenerEndpointRegistry> registries;
    private final ObjectProvider<ObservedPublicationRecorder> recorders;
    private final ObjectMapper mapper;
    private final String applicationName;

    /** Le manifeste est immuable pendant la vie du process : on le lit une fois. */
    private volatile List<Map<String, Object>> cachedPublishes;

    public EventManifestProvider(ObjectProvider<Binding> bindings,
                                 ObjectProvider<RabbitListenerEndpointRegistry> registries,
                                 ObjectProvider<ObservedPublicationRecorder> recorders,
                                 ObjectMapper mapper,
                                 String applicationName) {
        this.bindings = bindings;
        this.registries = registries;
        this.recorders = recorders;
        this.mapper = mapper;
        this.applicationName = applicationName;
    }

    public Map<String, Object> manifest() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("service", applicationName);
        body.put("consumes", consumes());
        body.put("listening", listening());
        body.put("publishes", publishes());

        ObservedPublicationRecorder recorder = recorders.getIfAvailable();
        if (recorder != null) {
            body.put("observed", recorder.snapshot());
        }
        return body;
    }

    public byte[] manifestAsJson() throws IOException {
        return mapper.writeValueAsBytes(manifest());
    }

    /** Bindings déclarés dans le contexte — y compris ceux jamais créés côté broker. */
    private List<Map<String, String>> consumes() {
        List<Map<String, String>> out = new ArrayList<>();
        bindings.stream()
                .filter(b -> b.getDestinationType() == Binding.DestinationType.QUEUE)
                .forEach(b -> {
                    Map<String, String> m = new LinkedHashMap<>();
                    m.put("exchange", b.getExchange());
                    m.put("queue", b.getDestination());
                    m.put("pattern", b.getRoutingKey());
                    out.add(m);
                });
        return out;
    }

    /**
     * Queues réellement attachées à un conteneur d'écoute. Complète {@link #consumes()} :
     * un {@code @RabbitListener(queues = "...")} sans bean {@code Binding} n'apparaît que là.
     */
    private List<String> listening() {
        RabbitListenerEndpointRegistry registry = registries.getIfAvailable();
        if (registry == null) {
            return List.of();
        }
        Set<String> queues = new LinkedHashSet<>();
        for (MessageListenerContainer container : registry.getListenerContainers()) {
            if (container instanceof AbstractMessageListenerContainer c) {
                String[] names = c.getQueueNames();
                if (names != null) {
                    queues.addAll(Arrays.asList(names));
                }
            }
        }
        return List.copyOf(queues);
    }

    /**
     * Fusionne les manifestes de tous les jars du classpath : un service découpé
     * en modules Maven en produit un par module.
     */
    private List<Map<String, Object>> publishes() {
        List<Map<String, Object>> cached = this.cachedPublishes;
        if (cached != null) {
            return cached;
        }
        List<Map<String, Object>> all = new ArrayList<>();
        try {
            Resource[] resources = new PathMatchingResourcePatternResolver().getResources(MANIFEST_PATTERN);
            for (Resource resource : resources) {
                try (InputStream in = resource.getInputStream()) {
                    all.addAll(mapper.readValue(in, new TypeReference<List<Map<String, Object>>>() { }));
                }
            }
        } catch (IOException e) {
            // Un manifeste illisible ne doit jamais empêcher le service de répondre :
            // le job dégradera en « publications inconnues » pour ce service.
            all = List.of();
        }
        this.cachedPublishes = List.copyOf(all);
        return this.cachedPublishes;
    }
}
