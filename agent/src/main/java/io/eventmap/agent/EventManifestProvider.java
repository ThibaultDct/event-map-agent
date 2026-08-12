package io.eventmap.agent;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.amqp.core.Binding;
import org.springframework.amqp.rabbit.listener.AbstractMessageListenerContainer;
import org.springframework.amqp.rabbit.listener.MessageListenerContainer;
import org.springframework.amqp.rabbit.listener.RabbitListenerEndpointRegistry;
import org.springframework.beans.factory.InitializingBean;
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
import java.util.function.UnaryOperator;

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
public class EventManifestProvider implements InitializingBean {

    private static final String MANIFEST_PATTERN = "classpath*:META-INF/event-publishers.json";
    private static final String CONSUMERS_PATTERN = "classpath*:META-INF/event-consumers.json";
    private static final String APPLICATION_PLACEHOLDER = PublishedEventProcessor.APPLICATION_PLACEHOLDER;

    private final ObjectProvider<Binding> bindings;
    private final ObjectProvider<RabbitListenerEndpointRegistry> registries;
    private final ObjectProvider<ObservedPublicationRecorder> recorders;
    private final ObjectMapper mapper;
    private final String applicationName;
    /** Sert à résoudre les `${...}` dans les noms de queues des @RabbitListener. */
    private final UnaryOperator<String> placeholderResolver;
    /** Ne déclarer que les messages réellement émis par ce service. */
    private final boolean attributeByObservation;

    /**
     * Le manifeste lu sur le classpath est immuable : on le parse une fois.
     * Le <em>filtrage</em> par observation, lui, ne peut pas être mis en cache —
     * les émissions s'accumulent pendant la vie du pod, et figer la liste au
     * premier appel masquerait tout ce qui est publié ensuite.
     */
    private volatile List<Map<String, Object>> parsedPublishes;
    private volatile List<Map<String, Object>> cachedExpectations;

    public EventManifestProvider(ObjectProvider<Binding> bindings,
                                 ObjectProvider<RabbitListenerEndpointRegistry> registries,
                                 ObjectProvider<ObservedPublicationRecorder> recorders,
                                 ObjectMapper mapper,
                                 String applicationName,
                                 UnaryOperator<String> placeholderResolver,
                                 boolean attributeByObservation) {
        this.bindings = bindings;
        this.registries = registries;
        this.recorders = recorders;
        this.mapper = mapper;
        this.applicationName = applicationName;
        this.placeholderResolver = placeholderResolver;
        this.attributeByObservation = attributeByObservation;
    }

    /**
     * Le filtrage par observation n'a de sens qu'avec l'enregistreur actif :
     * sans lui, aucune émission n'est vue et la liste des publications serait
     * intégralement vidée — un service parfaitement fonctionnel apparaîtrait
     * comme ne publiant rien. On refuse de démarrer plutôt que de produire une
     * carte silencieusement fausse.
     */
    @Override
    public void afterPropertiesSet() {
        if (attributeByObservation && recorders.getIfAvailable() == null) {
            throw new IllegalStateException(
                    "eventmap.attribute-by-observation=true exige eventmap.record-observed=true : "
                            + "l'attribution repose sur les publications observées, et sans enregistreur "
                            + "aucune ne le serait — le service se déclarerait producteur de rien.");
        }
    }

    public Map<String, Object> manifest() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("service", applicationName);
        body.put("consumes", consumes());
        body.put("listening", listening());
        body.put("publishes", publishes());
        body.put("expects", expectations());
        // Dit au job — et à qui interroge l'endpoint à la main — pourquoi la liste
        // des publications peut être plus courte que le catalogue du classpath.
        body.put("attribution", attributeByObservation ? "observed" : "declared");

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
        List<Map<String, Object>> all = parsedPublishes();
        if (!attributeByObservation) {
            return all;
        }
        // Les classes d'événements vivent souvent dans un module partagé : leur
        // manifeste se retrouve alors dans le jar de *tous* les services, et
        // chacun se déclarerait producteur du catalogue entier. Seule l'émission
        // réellement observée distingue le vrai émetteur des autres.
        ObservedPublicationRecorder recorder = recorders.getIfAvailable();
        if (recorder == null) {
            return List.of();
        }
        Set<String> seen = new LinkedHashSet<>();
        for (Map<String, Object> o : recorder.snapshot()) {
            Object key = o.get("routingKey");
            if (key != null) {
                seen.add(key.toString());
            }
        }
        List<Map<String, Object>> kept = new ArrayList<>();
        for (Map<String, Object> entry : all) {
            if (seen.contains(String.valueOf(entry.get("routingKey")))) {
                kept.add(entry);
            }
        }
        return List.copyOf(kept);
    }

    private List<Map<String, Object>> parsedPublishes() {
        List<Map<String, Object>> cached = this.parsedPublishes;
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
            all.forEach(this::resolveApplicationPlaceholder);
        } catch (IOException e) {
            // Un manifeste illisible ne doit jamais empêcher le service de répondre :
            // le job dégradera en « publications inconnues » pour ce service.
            all = List.of();
        }
        this.parsedPublishes = List.copyOf(all);
        return this.parsedPublishes;
    }

    /**
     * Ce que les {@code @RabbitListener} du service savent lire.
     *
     * <p>Les noms de queues viennent de l'annotation, où ils sont très souvent
     * écrits {@code ${app.queue.orders}} : on les résout ici, seul endroit qui
     * connaisse la configuration effective.
     */
    private List<Map<String, Object>> expectations() {
        List<Map<String, Object>> cached = this.cachedExpectations;
        if (cached != null) {
            return cached;
        }
        List<Map<String, Object>> all = new ArrayList<>();
        try {
            Resource[] resources = new PathMatchingResourcePatternResolver().getResources(CONSUMERS_PATTERN);
            for (Resource resource : resources) {
                try (InputStream in = resource.getInputStream()) {
                    all.addAll(mapper.readValue(in, new TypeReference<List<Map<String, Object>>>() { }));
                }
            }
            all.forEach(this::resolveQueuePlaceholders);
        } catch (IOException e) {
            all = List.of();
        }
        this.cachedExpectations = List.copyOf(all);
        return this.cachedExpectations;
    }

    @SuppressWarnings("unchecked")
    private void resolveQueuePlaceholders(Map<String, Object> entry) {
        Object queues = entry.get("queues");
        if (!(queues instanceof List<?> list)) {
            return;
        }
        List<String> resolved = new ArrayList<>(list.size());
        for (Object q : list) {
            String raw = String.valueOf(q);
            try {
                resolved.add(placeholderResolver.apply(raw));
            } catch (RuntimeException e) {
                // Placeholder non résolvable (SpEL `#{...}`, propriété absente) :
                // on garde la forme brute plutôt que de faire échouer l'endpoint.
                resolved.add(raw);
            }
        }
        ((Map<String, Object>) entry).put("queues", resolved);
    }

    /**
     * Remplace {@code {application}} par le nom réel du service.
     *
     * <p>La convention {@code evt.<application>.<NomDeClasse>} ne peut pas être
     * résolue à la compilation : {@code spring.application.name} est une valeur de
     * configuration, et l'artifactId Maven n'en est pas toujours le reflet. Le
     * processeur laisse donc un marqueur, et c'est le service — seul à connaître
     * son propre nom avec certitude — qui le substitue en servant le manifeste.
     */
    private void resolveApplicationPlaceholder(Map<String, Object> entry) {
        Object key = entry.get("routingKey");
        if (key instanceof String s && s.contains(APPLICATION_PLACEHOLDER)) {
            entry.put("routingKey", s.replace(APPLICATION_PLACEHOLDER, applicationName));
        }
    }
}
