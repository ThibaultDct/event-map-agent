package io.eventmap.agent;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Expose le manifeste sur le port applicatif, quand le service <em>est</em> une
 * application web (typiquement une API).
 *
 * <p>Pour un worker sans servlet, c'est {@link StandaloneManifestServer} qui prend
 * le relais sur son propre port. Les deux servent exactement le même corps, produit
 * par {@link EventManifestProvider}.
 */
@RestController
public class EventManifestEndpoint {

    private final EventManifestProvider provider;

    public EventManifestEndpoint(EventManifestProvider provider) {
        this.provider = provider;
    }

    @GetMapping(path = "${eventmap.path:/internal/event-manifest}", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> manifest() {
        return provider.manifest();
    }
}
