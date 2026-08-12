package io.eventmap.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.amqp.core.Binding;
import org.springframework.amqp.rabbit.connection.ConnectionNameStrategy;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.rabbit.listener.RabbitListenerEndpointRegistry;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnNotWebApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;

/**
 * Auto-configuration de l'agent : ajouter la dépendance suffit, il n'y a rien à
 * câbler dans les services.
 *
 * <p>Tout est désactivable par propriété, et rien n'est enregistré si le service
 * n'est pas une application web ou n'utilise pas AMQP.
 */
@AutoConfiguration
@ConditionalOnClass({ RabbitTemplate.class, ObjectMapper.class })
@ConditionalOnProperty(prefix = "eventmap", name = "enabled", havingValue = "true", matchIfMissing = true)
public class EventMapAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public EventManifestProvider eventManifestProvider(ObjectProvider<Binding> bindings,
                                                       ObjectProvider<RabbitListenerEndpointRegistry> registries,
                                                       ObjectProvider<ObservedPublicationRecorder> recorders,
                                                       ObjectProvider<ObjectMapper> mappers,
                                                       Environment env) {
        String appName = env.getProperty("spring.application.name", "unknown");
        ObjectMapper mapper = mappers.getIfAvailable(ObjectMapper::new);
        return new EventManifestProvider(bindings, registries, recorders, mapper, appName,
                env::resolvePlaceholders);
    }

    /** Service web : le manifeste se greffe sur le port applicatif existant. */
    @Bean
    @ConditionalOnWebApplication
    @ConditionalOnMissingBean
    public EventManifestEndpoint eventManifestEndpoint(EventManifestProvider provider) {
        return new EventManifestEndpoint(provider);
    }

    /**
     * Worker sans servlet : on ouvre un port dédié avec le serveur HTTP du JDK.
     *
     * <p>Sans ce repli, un système majoritairement composé de workers — le cas
     * ordinaire en événementiel — ne remonterait aucune publication, et la
     * moitié producteur de la carte resterait vide.
     */
    @Bean
    @ConditionalOnNotWebApplication
    @ConditionalOnMissingBean
    public StandaloneManifestServer standaloneManifestServer(EventManifestProvider provider, Environment env) {
        int port = env.getProperty("eventmap.standalone-port", Integer.class, 8081);
        String path = env.getProperty("eventmap.path", "/internal/event-manifest");
        return new StandaloneManifestServer(provider, port, path);
    }

    /**
     * Sans stratégie de nommage, {@code /api/consumers} du management RabbitMQ ne
     * montre qu'une IP et un port. Nommer la connexion d'après le service donne au
     * job un second signal de corrélation, indépendant de l'IP du pod — précieux
     * pendant un rolling update, où les IP changent sous les pieds du scan.
     */
    @Bean
    @ConditionalOnMissingBean
    public ConnectionNameStrategy eventMapConnectionNameStrategy(Environment env) {
        String appName = env.getProperty("spring.application.name", "unknown");
        return connectionFactory -> appName;
    }

    @Bean
    @ConditionalOnProperty(prefix = "eventmap", name = "record-observed", havingValue = "true")
    public ObservedPublicationRecorder observedPublicationRecorder(Environment env) {
        int max = env.getProperty("eventmap.max-observed-keys", Integer.class, 500);
        return new ObservedPublicationRecorder(max);
    }

    /**
     * Branche l'enregistreur sur tous les {@link RabbitTemplate} du contexte.
     *
     * <p>On passe par {@code add...} et non {@code set...} : un service a souvent
     * déjà ses propres post-processeurs (tracing, chiffrement, en-têtes métier), et
     * les écraser silencieusement serait une régression difficile à diagnostiquer.
     */
    @Bean
    @ConditionalOnProperty(prefix = "eventmap", name = "record-observed", havingValue = "true")
    public static BeanPostProcessor eventMapRecorderRegistrar(ObjectProvider<ObservedPublicationRecorder> recorders) {
        return new BeanPostProcessor() {
            @Override
            public Object postProcessAfterInitialization(Object bean, String beanName) throws BeansException {
                if (bean instanceof RabbitTemplate template) {
                    ObservedPublicationRecorder recorder = recorders.getIfAvailable();
                    if (recorder != null) {
                        template.addBeforePublishPostProcessors(recorder);
                    }
                }
                return bean;
            }
        };
    }
}
