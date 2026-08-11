package io.eventmap.agent;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Sert le manifeste sur un worker qui n'est pas une application web.
 *
 * <p>Un worker AMQP typique ne dépend que de {@code spring-boot-starter-amqp} :
 * pas de servlet, pas de port, donc pas de {@code @RestController} possible.
 * Plutôt que d'imposer {@code spring-boot-starter-web} — et le démarrage d'un
 * Tomcat complet — à chaque worker uniquement pour exposer un objet JSON en
 * lecture seule, on s'appuie sur le serveur HTTP livré avec le JDK
 * ({@code jdk.httpserver}). Zéro dépendance ajoutée, un thread, quelques kilo-octets.
 *
 * <p>Il n'écoute que ce qu'on lui demande : une seule route, en {@code GET}, sans
 * état ni écriture. Il reste néanmoins joignable depuis le réseau du pod — voir
 * la note d'exposition dans le README.
 */
public class StandaloneManifestServer implements InitializingBean, DisposableBean {

    private static final Logger log = Logger.getLogger(StandaloneManifestServer.class.getName());

    private final EventManifestProvider provider;
    private final int port;
    private final String path;
    private HttpServer server;

    public StandaloneManifestServer(EventManifestProvider provider, int port, String path) {
        this.provider = provider;
        this.port = port;
        this.path = path;
    }

    @Override
    public void afterPropertiesSet() {
        try {
            server = HttpServer.create(new InetSocketAddress(port), 0);
            server.createContext(path, this::handle);
            // Un seul thread suffit : le job interroge un pod par Deployment, une
            // fois par scan. Un pool ici serait de la complexité sans usage.
            server.setExecutor(Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "eventmap-manifest");
                t.setDaemon(true);
                return t;
            }));
            server.start();
            log.info(() -> "event-map : manifeste exposé sur http://0.0.0.0:" + port + path);
        } catch (IOException e) {
            // Ne jamais empêcher le worker de démarrer pour un outil de
            // cartographie : le job signalera simplement `manifest-unreachable`.
            log.log(Level.WARNING, e,
                    () -> "event-map : impossible d'ouvrir le port " + port + ", manifeste non exposé");
        }
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(405, -1);
                return;
            }
            byte[] body = provider.manifestAsJson();
            exchange.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        } catch (RuntimeException | IOException e) {
            log.log(Level.WARNING, e, () -> "event-map : échec de génération du manifeste");
            byte[] err = "{\"error\":\"manifest unavailable\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(500, err.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(err);
            }
        } finally {
            exchange.close();
        }
    }

    @Override
    public void destroy() {
        if (server != null) {
            server.stop(0);
        }
    }
}
