# event-system-visualizer

Découverte automatique de la topologie événementielle d'un système Spring Boot + RabbitMQ
déployé sur Kubernetes. Un job déclenché produit une carte « qui envoie quoi, à qui »,
versionnée dans git, explorable dans un viewer autonome et exportable en DrawIO.

Le graphe est le sous-produit. **Le livrable, c'est le diff** : événements orphelins,
queues fantômes, bindings dérivés, apparus depuis le dernier scan.

---

## Table des matières

1. [Le problème](#1-le-problème)
2. [Ce que l'outil produit](#2-ce-que-loutil-produit)
3. [Prérequis](#3-prérequis)
4. [Démarrage rapide](#4-démarrage-rapide)
5. [Installation détaillée](#5-installation-détaillée)
   - [Partie 1 — Essai local, zéro modification](#partie-1--essai-local-zéro-modification)
   - [Partie 2 — Le job dans le cluster](#partie-2--le-job-dans-le-cluster)
   - [Partie 3 — Les producteurs](#partie-3--les-producteurs)
   - [Partie 4 — Automatiser](#partie-4--automatiser)
6. [Les trois vues](#6-les-trois-vues)
7. [Le catalogue d'anomalies](#7-le-catalogue-danomalies)
8. [Configuration](#8-configuration)
9. [Dépannage](#9-dépannage)
10. [Tenue en charge](#10-tenue-en-charge)
11. [Ce que l'outil ne sait pas faire](#11-ce-que-loutil-ne-sait-pas-faire)
12. [Développement](#12-développement)

---

## 1. Le problème

Dans un exchange topic, les deux moitiés de la carte n'ont rien à voir en difficulté :

- **Les consommateurs sont déclaratifs.** Un binding `exchange → queue` avec son pattern
  existe dans le broker. On le lit, c'est fini.
- **Les producteurs sont invisibles.** Publier, c'est un appel `convertAndSend` noyé dans
  du code métier, avec une routing key souvent construite dynamiquement. Le broker n'en
  garde aucune trace.

D'où l'architecture : la topologie vient du broker et de Kubernetes, les publications
viennent d'un manifeste que chaque service produit **à la compilation**.

```
1. K8s API      → pods, IP, deployments, labels        ┐
2. Mgmt API     → exchanges, queues, bindings, consumers├→ IR ─┬→ event-map.json  (git, diffable)
3. Manifestes   → /internal/event-manifest (1 pod/deploy)┘     ├→ event-map.html  (viewer)
4. Corrélation  → consumer.peer_host ↔ pod.status.podIP        ├→ event-map.drawio
5. Résolution   → amqpMatch(pattern, routingKey) → arêtes      └→ REPORT.md       (diff en PR)
```

La pièce qui rend la carte *précise* plutôt qu'approximative est à l'étape 4 :
`/api/consumers` expose le `peer_host` de chaque consommateur, c'est-à-dire l'IP du pod.
Croisée avec la liste des pods, elle donne la vraie relation `queue ↔ Deployment`,
sans rien instrumenter.

---

## 2. Ce que l'outil produit

| Fichier | Rôle |
|---|---|
| `event-map.json` | L'IR. Trié de façon déterministe pour que deux runs identiques donnent un diff vide |
| `event-map.html` | Viewer autonome à trois vues. Cytoscape inliné, aucun CDN, aucun serveur |
| `event-map.drawio` | Vue d'ensemble + topologie des queues + **une page par service** + légende |
| `REPORT.md` | Le diff vs le run précédent. C'est le corps de la PR |

---

## 3. Prérequis

| | |
|---|---|
| **Node.js 20+** | pour lancer l'outil et les scripts d'installation |
| **kubectl** | configuré sur le cluster cible |
| **Docker** | uniquement pour la partie 2 (construction de l'image) |
| **JDK 17+ / Maven** | uniquement pour la partie 3 (l'agent Java) |
| **RabbitMQ** | plugin `rabbitmq_management` activé |

Les parties sont indépendantes : la partie 1 ne demande que Node et kubectl.

---

## 4. Démarrage rapide

Si vous savez déjà ce que vous faites :

```bash
npm install && npm run try
```

Puis, pour déployer dans le cluster :

```bash
npm run setup
```

Le premier lance un scan depuis votre poste sans rien installer. Le second pose 12
questions et génère les manifestes Kubernetes. Le détail de chaque étape est ci-dessous.

---

## 5. Installation détaillée

### Partie 1 — Essai local, zéro modification

**Objectif** : vérifier que l'outil voit votre RabbitMQ et votre cluster, et juger le
résultat, avant d'installer quoi que ce soit.

#### Étape 1.1 — Installer les dépendances

```bash
npm install
```

#### Étape 1.2 — Lancer l'essai

```bash
npm run try
```

Le script ouvre lui-même le tunnel vers l'API management, lance la découverte, referme le
tunnel et ouvre le viewer. Il pose 6 questions, toutes avec une valeur par défaut :

```
Namespace de RabbitMQ [messaging] :
Nom du Service RabbitMQ [rabbitmq] :
Port de l'API management [15672] :
Utilisateur RabbitMQ [guest] :
Mot de passe [guest] :
vhost [/] :
```

> **✅ Point de contrôle.** Vous devez voir défiler les 8 étapes, puis le compte de vos
> exchanges, queues, bindings et consumers. Quatre fichiers apparaissent dans `out/`, et
> `out/event-map.html` s'ouvre.

> **⚠️ Attendu à ce stade** : la colonne « producteurs » de la matrice est vide, et le
> rapport annonce `manifest-unreachable` partout. C'est normal — aucun service n'a encore
> déclaré ce qu'il publie. **Les consommateurs, eux, sont déjà exacts.**

Si vous préférez piloter à la main, l'équivalent sans script :

```bash
kubectl port-forward -n messaging svc/rabbitmq 15672:15672
```

```bash
RABBIT_MGMT_URL=http://localhost:15672 RABBIT_USER=guest RABBIT_PASS=guest COLLECT_MANIFESTS=false node dist/index.js
```

`COLLECT_MANIFESTS=false` est indispensable depuis un poste : les IP de pods n'y sont pas
routables, et chaque appel attendrait son timeout.

---

### Partie 2 — Le job dans le cluster

**Objectif** : que la découverte tourne dans le cluster, où elle peut joindre les pods.

#### Étape 2.1 — Créer un utilisateur RabbitMQ en lecture seule

Le tag **`monitoring`** donne l'accès en lecture à l'API management. **Jamais
`administrator`.** Choisissez la méthode qui correspond à votre déploiement.

<details open><summary><b>RabbitMQ classique (StatefulSet, Helm Bitnami…)</b></summary>

```bash
kubectl exec -n messaging rabbitmq-0 -- rabbitmqctl add_user eventmap 'UN_MOT_DE_PASSE_SOLIDE'
```

```bash
kubectl exec -n messaging rabbitmq-0 -- rabbitmqctl set_user_tags eventmap monitoring
```

```bash
kubectl exec -n messaging rabbitmq-0 -- rabbitmqctl set_permissions -p / eventmap "^$" "^$" ".*"
```

La troisième commande donne le droit de *lire* et rien d'autre : configure et write sont
des regex qui ne matchent rien.
</details>

<details><summary><b>RabbitMQ Cluster Operator (CRD <code>User</code>)</b></summary>

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: User
metadata:
  name: eventmap
  namespace: messaging
spec:
  tags: [monitoring]
  rabbitmqClusterReference:
    name: rabbitmq
---
apiVersion: rabbitmq.com/v1beta1
kind: Permission
metadata:
  name: eventmap-read
  namespace: messaging
spec:
  vhost: "/"
  userReference:
    name: eventmap
  permissions:
    write: "^$"
    configure: "^$"
    read: ".*"
  rabbitmqClusterReference:
    name: rabbitmq
```

L'opérateur crée un Secret `eventmap-user-credentials` — réutilisez-le à l'étape 2.4
plutôt que de créer `rabbit-monitoring`.
</details>

<details><summary><b>Interface web</b></summary>

Admin → Add a user → nom `eventmap`, tag `monitoring` → puis « Set permission » sur le
vhost avec Configure `^$`, Write `^$`, Read `.*`.
</details>

> **✅ Point de contrôle.** Relancez `npm run try` avec ce compte au lieu de `guest`. Si
> le scan aboutit, les droits sont bons.

#### Étape 2.2 — Construire et pousser l'image

```bash
docker build -t registry.internal/event-system-visualizer:1.0.0 .
```

```bash
docker push registry.internal/event-system-visualizer:1.0.0
```

Remplacez `registry.internal` par votre registry. Si votre cluster tire depuis un registry
privé, assurez-vous que le namespace dispose du `imagePullSecrets` correspondant.

#### Étape 2.3 — Générer les manifestes

```bash
npm run setup
```

Le script pose ses questions et écrit trois fichiers dans `deploy/generated/` :

| Fichier | Contenu |
|---|---|
| `rbac.yaml` | ServiceAccount + ClusterRole en **lecture seule** (`pods`, `deployments`, `statefulsets`, `replicasets`) |
| `job.yaml` | Un Job à usage unique — c'est ce qu'on lance en premier |
| `cronjob.yaml` | Le même, en gabarit suspendu, pour les relances ultérieures |

**Aucun secret n'est écrit sur disque** : les manifestes ne contiennent que des
références `secretKeyRef`, et le script imprime les commandes `kubectl create secret` à
exécuter vous-même.

Pour régénérer sans questions — utile en CI :

```bash
CLUSTER_NAME=prod K8S_NAMESPACES=orders,billing IMAGE=registry.internal/event-system-visualizer:1.0.0 npm run setup -- --yes
```

Chaque question a une variable d'environnement du même nom qu'à l'exécution du job.

#### Étape 2.4 — Créer le secret RabbitMQ

```bash
kubectl create secret generic rabbit-monitoring -n platform --from-literal=username=eventmap --from-literal=password='UN_MOT_DE_PASSE_SOLIDE'
```

Et, seulement si vous avez activé la publication git :

```bash
kubectl create secret generic event-map-git -n platform --from-literal=token='VOTRE_JETON'
```

Le jeton doit pouvoir pousser une branche et ouvrir une PR sur le dépôt de doc — rien de
plus.

#### Étape 2.5 — Déployer et lancer

```bash
kubectl apply -f deploy/generated/rbac.yaml -f deploy/generated/job.yaml
```

```bash
kubectl logs -n platform -f job/event-map-discovery-run
```

> **✅ Point de contrôle.** Les 8 étapes défilent, puis le rapport s'affiche. Si la
> publication git est active, une PR apparaît sur votre dépôt de doc.

#### Étape 2.6 — Installer le gabarit de relance

```bash
kubectl apply -f deploy/generated/cronjob.yaml
```

La CronJob est livrée `suspend: true` : elle sert de gabarit, pas de planification. Pour
relancer à la demande :

```bash
kubectl create job --from=cronjob/event-map-discovery eventmap-$(date +%s) -n platform
```

> **⚠️ Le bon moment est après un déploiement complet, jamais pendant un rolling update.**
> Un scan à cheval sur deux versions capture un mélange d'anciens et de nouveaux pods et
> produit une carte incohérente.

---

### Partie 3 — Les producteurs

**Objectif** : remplir la moitié manquante de la carte. C'est le seul travail côté Java.

#### Étape 3.1 — Publier l'agent

Pour un premier essai, le dépôt Maven local suffit :

```bash
cd agent && mvn install
```

Pour de vrai, ajoutez un bloc `<distributionManagement>` pointant vers votre registry
interne dans [agent/pom.xml](agent/pom.xml), puis :

```bash
cd agent && mvn deploy
```

#### Étape 3.2 — Ajouter la dépendance

Une seule fois, dans le pom parent de tous vos services :

```xml
<dependency>
  <groupId>io.eventmap</groupId>
  <artifactId>event-map-agent</artifactId>
  <version>1.0.0</version>
</dependency>
```

L'agent n'ajoute **aucune dépendance transitive** — tout y est `provided`, il se greffe
sur ce que le service possède déjà. Il s'auto-configure : il n'y a rien à câbler.

Il apporte trois choses :

| | |
|---|---|
| `GET /internal/event-manifest` | Expose les bindings et queues écoutées, lus **dans le contexte Spring** — pas devinés |
| `@PublishesEvent` | Déclare une publication ; un processeur d'annotations la grave dans `META-INF/event-publishers.json` au build |
| `ConnectionNameStrategy` | Nomme les connexions AMQP d'après `spring.application.name`, second signal de corrélation |

#### Étape 3.3 — Déclarer les publications

Il y a **deux niveaux**, et le premier ne demande aucune modification de code.

**Niveau 1 — une ligne de configuration, zéro annotation.**

```yaml
eventmap:
  record-observed: true
```

L'agent enregistre alors les triplets `(exchange, routing key, type de payload)`
réellement publiés. La carte se remplit dès que le trafic passe.

C'est une **preuve d'existence, jamais une preuve d'exhaustivité** : un chemin de code
jamais emprunté depuis le démarrage du pod reste invisible. Ces arêtes sont marquées
`observed` et tracées en pointillé. Excellent pour démarrer et pour découvrir l'existant,
insuffisant comme documentation de référence.

**Niveau 2 — annoter, pour une carte exacte.**

```java
@PublishesEvent(routingKey = "evt.order.created", payload = OrderCreatedEvent.class)
public void publishOrderCreated(Order order) {
    rabbitTemplate.convertAndSend(EXCHANGE, "evt.order.created", toEvent(order));
}
```

L'annotation est répétable, et `exchange` peut être omis si le système n'a qu'un seul
exchange topic — le job le déduit. Le processeur casse le build si la routing key contient
un joker AMQP.

Renseigner `payload` active en plus la **détection de rupture de contrat** : le processeur
extrait la structure de la classe et le job compare d'un scan à l'autre
(cf. [§7 bis](#7-bis-les-ruptures-de-contrat)).

> **Pourquoi une annotation plutôt qu'un scan automatique du code ?** Parce qu'une
> heuristique sur les appels `convertAndSend` plafonne vers 85 % dès que les routing keys
> sont concaténées ou tirées d'une enum — et qu'elle échoue *silencieusement*. Une ligne
> d'annotation monte à 100 %, et l'erreur devient visible à la compilation.

Les deux niveaux se cumulent : activez `record-observed` pour rattraper les clés
dynamiques que l'annotation ne peut pas exprimer.

#### Étape 3.4 — Vérifier avant de déployer

Lancez le service en local, puis :

```bash
curl localhost:8080/internal/event-manifest
```

> **✅ Point de contrôle.** Un JSON avec `consumes`, `listening` et `publishes`. Si
> `publishes` est vide alors que vous avez annoté, le processeur n'a pas tourné : faites
> un `mvn clean` et vérifiez que l'agent est bien sur le classpath de compilation.

#### Étape 3.5 — Déployer, puis relancer le scan

```bash
kubectl create job --from=cronjob/event-map-discovery eventmap-$(date +%s) -n platform
```

Cette fois la matrice se remplit des deux côtés, et le rapport compare au run précédent.

Un service à la fois suffit — la carte se complète progressivement, et
`manifest-unreachable` vous dit exactement lesquels manquent encore.

---

### Partie 3 bis — Cas d'un système de workers

Le cas le plus courant : N workers qui s'échangent des événements **et** des commandes,
sans API web devant. Deux points le distinguent d'un système à APIs.

**Les workers n'ont pas de port HTTP.** L'agent le détecte et ouvre le sien
(cf. [§8](#lagent-java)). Rien à faire, sinon vérifier que `MANIFEST_PORTS` contient bien
`8081` et que vos NetworkPolicy laissent passer le job.

**Une commande est adressée, un événement est diffusé.** C'est ce qui doit se refléter
dans la topologie du broker, sans quoi l'outil classera correctement les messages mais la
carte sera fausse.

| | Événement | Commande |
|---|---|---|
| Clé émise | `evt.<mon-domaine>.<verbe>` | `cmd.<domaine-cible>.<action>` |
| Qui décide du destinataire | le consommateur, en se bindant | le producteur, dans la clé |
| Binding du consommateur | `evt.<domaine-amont>.*` | `cmd.<mon-domaine>.*` |

Concrètement, chaque worker déclare **deux queues** :

```java
@Bean Queue billingCommands() { return new Queue("billing.cmd.q"); }
@Bean Binding billingCommandBinding(Queue billingCommands, TopicExchange app) {
    // Tout ce qui m'est adressé — c'est l'émetteur qui a choisi ma boîte.
    return BindingBuilder.bind(billingCommands).to(app).with("cmd.billing.*");
}

@Bean Queue orderEvents() { return new Queue("billing.order.q"); }
@Bean Binding orderEventBinding(Queue orderEvents, TopicExchange app) {
    // Ce que je choisis d'écouter — order-worker ne sait pas que j'existe.
    return BindingBuilder.bind(orderEvents).to(app).with("evt.order.*");
}
```

Sans la queue `cmd.<mon-domaine>.*`, toutes les commandes qui vous sont adressées
tombent en `orphan-event` : le broker les jette faute de binding. C'est d'ailleurs le
premier défaut que la carte vous remontera si la convention n'est pas tenue.

**Une queue par domaine amont, pas une queue fourre-tout.** `billing.order.q` et
`billing.shipping.q` plutôt qu'un unique `billing.q` bindé sur `evt.#` : la carte
distingue alors les flux, et un incident sur un amont ne bloque pas les autres.

---

### Partie 4 — Automatiser

Le job prend tout son sens déclenché **après chaque déploiement**. Exemple GitHub Actions :

```yaml
- name: Cartographier les événements
  run: |
    kubectl create job --from=cronjob/event-map-discovery "eventmap-${GITHUB_RUN_ID}" -n platform
    kubectl wait --for=condition=complete --timeout=15m "job/eventmap-${GITHUB_RUN_ID}" -n platform
    kubectl logs -n platform "job/eventmap-${GITHUB_RUN_ID}"
```

Deux garde-fous, à activer dans cet ordre :

**`FAIL_ON_BREAKING_SCHEMA=true` dès le premier jour.** Une rupture de contrat n'a
pratiquement pas de faux positif : un champ retiré d'un payload consommé casse. Le job
échoue en nommant les consommateurs impactés.

**`FAIL_ON_NEW_WARNINGS=true` plus tard**, quand la base est assainie.

> **⚠️ N'activez pas le second au premier jour.** Le premier rapport liste une dette
> accumulée depuis des années, pas une régression. Traitez-le comme un inventaire à trier.

---

## 6. Les trois vues

### Pourquoi pas un seul grand graphe

C'était le premier design, et il ne tient pas. Mesuré sur un système de 26 services :

| | |
|---|---|
| Degré moyen | **9,1** — un node-link décroche au-delà de ~4 |
| Arêtes passant par les 2 consommateurs `evt.#` | **46 %** |
| Arêtes retour (cycles à casser dans un layout en couches) | **36** |
| Arêtes dont l'étiquette est tronquée | **71 / 118** — 60 % des arêtes affichaient une info incomplète |

Trois propriétés inhérentes au pub/sub tuent le diagramme : les **consommateurs
transverses** touchent tout le monde, les **cycles** sont la norme (A→B→A), et il y a
**492 routing keys pour 118 arêtes** — impossible à étiqueter. Regrouper par namespace ne
masquerait que 26 % des arêtes : ça ne sauve rien.

### Matrice

Lignes = producteurs, colonnes = consommateurs. Zéro croisement possible, zéro étiquette à
placer, scalable à plusieurs centaines de services.

Les lignes et colonnes sont **sériées** — réordonnées par similarité de voisinage — ce qui
fait apparaître les contextes bornés en blocs sur la diagonale et les consommateurs
transverses en colonnes pleines. Le tri est déterministe pour que la matrice ne se
réorganise pas à chaque scan, sinon le diff git deviendrait inutile.

Un `↻` sur la diagonale signale un service qui consomme ses propres événements. Cliquer un
en-tête ouvre l'explorateur sur ce service.

### Explorateur

Le voisinage à un saut d'un service : producteurs à gauche, lui au centre, consommateurs à
droite. À degré 9, un service *isolé* est parfaitement lisible ; c'est seulement leur
superposition qui produisait le plat de nouilles. On ne change pas la donnée, on change la
portée de ce qu'on affiche à la fois.

Sous le graphe, la **fiche entrée/sortie** répond directement, sans qu'on ait à suivre
une arête :

```
↓ ENTRÉE                              ↑ SORTIE
CMD cmd.delivery.dispatch             CMD cmd.customer.retry
  ← pricing-worker                      → customer-worker
  via delivery.cmd.q · DeliveryCommand   via customer.cmd.q · CustomerCommand
                                         com.acme.delivery.Commands#sendCustomer
```

Chaque ligne porte la nature du message, sa clé, **qui est à l'autre bout**, la queue
traversée, la classe de payload et — pour les sortants — l'emplacement Java de la
publication. Tous les noms de service y sont cliquables : on remonte une chaîne de proche
en proche.

Les sortants sont construits depuis les publications déclarées, pas depuis les flux : un
message que personne ne consomme apparaît donc quand même, surligné, avec la mention
« personne — le broker jette le message ». C'est précisément ce qu'on veut voir.

### Le langage visuel

Il est unique et partagé par les trois vues.

| | Événement | Commande |
|---|---|---|
| Clé | `evt.*` | `cmd.*` |
| Sémantique | un fait diffusé | un ordre adressé |
| Couleur | vert | violet |
| Trait | plein | tireté |
| Flèche | pleine | en chevron |
| Pastille | `EVT` | `CMD` |

Le trait tireté double la couleur : la distinction reste lisible en niveaux de gris et
pour un daltonisme rouge-vert. L'épaisseur d'une arête suit le nombre de clés distinctes,
et son étiquette donne les **volumes** (`3 evt · 1 cmd`) plutôt que la liste des clés —
empiler quatre routing keys sur une arête produisait un pavé illisible dès qu'un couple de
services échangeait plus de deux ou trois messages.

### Événements

L'événement devient l'objet de premier plan : une ligne par routing key, avec producteurs,
consommateurs, queue et payload. C'est la vue qui répond aux deux questions du quotidien —
« qui consomme `evt.order.created` ? » et « si je change ce payload, qui casse ? » — et à
laquelle un graphe de services répond très mal. Les orphelins y sont surlignés, avec un
filtre dédié.

### Les pages DrawIO

La page d'ensemble garde sa valeur d'inventaire mais fait plus de 5 000 px de large :
personne ne l'ouvre deux fois. Les **pages ego, une par service**, tiennent dans un écran
et se collent dans une doc d'équipe — c'est le vrai livrable du fichier.

La page **Topologie** intercale les queues et inclut **toutes les queues bindées**, même
celles qu'aucun flux ne traverse. C'est ce qui rend les pathologies lisibles, là où une vue
construite à partir des seuls flux les faisait disparaître :

| Ce qu'on voit | Ce que c'est |
|---|---|
| Une flèche part de la queue vers un worker, rien n'entre | Queue affamée — quelqu'un écoute, personne n'émet |
| Un producteur pousse vers la queue, la flèche s'arrête | Queue fantôme — les messages s'accumulent |
| Le nœud flotte, isolé des deux côtés | Queue morte |

---

## 7. Le catalogue d'anomalies

C'est là que se trouve la valeur opérationnelle. Chaque code répond à une question précise.

| Code | Ce que ça veut dire | Quoi en faire |
|---|---|---|
| `orphan-event` | Un service publie une routing key qu'aucun binding ne matche. **Le broker jette le message.** | Bug franc. Binding manquant ou faute de frappe dans la clé |
| `ghost-queue` | Queue bindée sans consommateur. Le niveau passe à `error` s'il y a du backlog | Worker mort, ou queue oubliée après un refactor |
| `starved-queue` | Quelqu'un consomme, aucun producteur connu n'alimente | Producteur hors périmètre, ou publication non déclarée |
| `binding-drift` | Binding déclaré dans le code, absent du broker | Déploiement incomplet, ou binding créé à la première connexion |
| `unknown-consumer` | Un consommateur AMQP dont l'IP ne correspond à aucun pod scanné | Namespace hors périmètre, port-forward d'un dev, ou consommateur hors cluster |
| `manifest-unreachable` | Un pod n'a pas répondu sur `/internal/event-manifest` | Agent non déployé sur ce service — sa moitié producteur manquera |
| `dynamic-key` | Routing key non résolue statiquement | Annoter la valeur concrète, ou activer `record-observed` |

---

## 7 bis. Les ruptures de contrat

C'est ce qui fait passer l'outil de carte à garde-fou. La carte répond « qui consomme
`evt.order.created` ». La comparaison de schémas répond **« je viens de retirer un champ,
qui casse »** — et comme la topologie est déjà résolue, elle peut nommer les impactés.

Quand une publication est annotée avec un `payload`, le processeur d'annotations extrait à
la compilation la structure de la classe, aplatie en chemins typés :

```
orderId                   java.util.UUID
customer.address.city     java.lang.String
lines[]                   com.acme.OrderLine
lines[].sku               java.lang.String
status                    enum[CREATED,PAID,CANCELLED]
attributes{}              Map<String,String>
```

Le format est plat et non arborescent à dessein : comparer deux versions se réduit à une
différence d'ensembles, et le message d'alerte se lit tel quel.

Au scan suivant, le job compare et classe :

| Changement | Verdict |
|---|---|
| Champ **supprimé** | 🔴 rupture — les consommateurs qui le lisent cassent |
| Champ **retypé** | 🔴 rupture |
| Champ **ajouté** | additif, sans danger pour un consommateur tolérant |
| Constante d'enum retirée | 🔴 rupture (le type porte ses constantes) |
| `List<Foo>` → `Foo` | 🔴 rupture (le suffixe `[]` porte la cardinalité) |

Le rapport devient alors actionnable :

```markdown
### 🔴 Ruptures de contrat (2)

- **`evt.audit.created`** — `total` : `long` → `BigDecimal`
  - impacte **9** consommateur(s) : commerce/fraud-worker, data/analytics-worker, …
  - publié par fulfilment/audit-worker — `com.acme.audit.AuditService#publishCreated`
```

Dans le viewer, l'onglet **Messages** affiche le nombre de champs de chaque payload ; un
clic déplie le schéma complet, indenté selon l'imbrication.

### Le garde-fou

```bash
FAIL_ON_BREAKING_SCHEMA=true
```

Séparé de `FAIL_ON_NEW_WARNINGS` à dessein : une rupture de contrat n'a pratiquement pas de
faux positif, alors que les anomalies de topologie en comportent tant que la dette initiale
n'est pas triée. **Activez celui-ci dès le premier jour**, et l'autre bien plus tard.

### Ce que le schéma ne capture pas

**On lit les champs, Jackson sérialise les accesseurs.** Pour un record, une classe Lombok
`@Data` ou un POJO ordinaire, les deux coïncident. Pour une classe dont un getter calcule
une valeur sans champ correspondant, la propriété sera absente du schéma. `@JsonIgnore` et
`@JsonProperty("nom")` sont en revanche respectés, et les champs `static`, `transient` et
synthétiques exclus.

**Seul le côté producteur est décrit.** On compare un payload à sa propre version
précédente, pas à ce que les consommateurs attendent réellement. Décrire aussi les
paramètres des `@RabbitListener` permettrait de détecter un désaccord producteur/consommateur
sans attendre le déploiement — c'est la suite naturelle, pas encore faite.

**La profondeur est bornée à 4 niveaux**, et les références circulaires sont coupées : un
graphe d'objets profond n'apporte plus d'information de contrat utile.

---

## 8. Configuration

### Le job

| Variable | Défaut | |
|---|---|---|
| `RABBIT_MGMT_URL` | — | **requis**, ex. `http://rabbitmq.messaging.svc:15672` |
| `RABBIT_USER` / `RABBIT_PASS` | — | **requis**, utilisateur taggé `monitoring` |
| `RABBIT_VHOST` | `/` | |
| `K8S_NAMESPACES` | *(tous)* | Liste séparée par des virgules. Restreindre accélère nettement |
| `K8S_NAME_LABELS` | `app.kubernetes.io/name,app.kubernetes.io/instance,app` | Labels essayés dans l'ordre pour nommer un workload |
| `MANIFEST_PORTS` | `8080,8081` | Ports sondés dans l'ordre. 8080 = API web, 8081 = worker sans servlet |
| `MANIFEST_PATH` | `/internal/event-manifest` | |
| `MANIFEST_TIMEOUT_MS` | `4000` | |
| `COLLECT_MANIFESTS` | `true` | `false` = topologie broker seule |
| `EVENT_PREFIXES` / `COMMAND_PREFIXES` | `evt,event` / `cmd,command` | Premier mot de la routing key |
| `DLQ_PATTERNS` / `RETRY_PATTERNS` | `.dlq,.dead,-dlq,.parking` / `.retry,-retry,.delay` | |
| `IGNORE_EXCHANGES` | exchanges `amq.*` | |
| `OUTPUT_DIR` | `./out` | |
| `STALE_AFTER_RUNS` | `3` | Runs consécutifs sans observation avant retrait |
| `LAYOUT_MAX_EXACT_NODES` | `60` | Au-delà, placement rapide plutôt que compact |
| `PREVIOUS_MAP_PATH` | — | Carte précédente quand git est désactivé |
| `GIT_ENABLED` | `false` | |
| `GIT_REPO_URL` / `GIT_REPO_DIR` / `GIT_SUBDIR` | — / `./repo` / `docs/event-map` | |
| `GIT_BASE_BRANCH` / `GIT_BRANCH_PREFIX` | `main` / `eventmap/` | |
| `GIT_OPEN_PR` | `false` | Nécessite `GITHUB_TOKEN` et `GITHUB_REPOSITORY` |
| `FAIL_ON_BREAKING_SCHEMA` | `false` | Sortie en code 1 si un payload perd un champ ou en change le type |
| `FAIL_ON_NEW_WARNINGS` | `false` | Sortie en code 1 si de nouvelles anomalies non-`info` apparaissent |
| `CLUSTER_NAME` | — | Affiché dans la carte |

Le token git n'est jamais persisté dans un remote : il est injecté via un header HTTP
éphémère au clone et au push, pour ne pas se retrouver lisible dans `.git/config`.

### L'agent Java

```yaml
eventmap:
  enabled: true                  # défaut
  path: /internal/event-manifest # défaut
  standalone-port: 8081          # worker sans servlet uniquement
  record-observed: false         # niveau 1 (cf. étape 3.3)
  max-observed-keys: 500         # borne la cardinalité
```

**Worker sans `spring-boot-starter-web`.** Un worker AMQP n'a ni servlet ni port : un
`@RestController` n'y est jamais instancié. L'agent ouvre donc un port dédié avec le
serveur HTTP livré dans le JDK (`jdk.httpserver`) — aucune dépendance ajoutée, un thread
démon, une seule route en lecture. Si le port est déjà pris, l'agent journalise un
avertissement et le worker démarre quand même : un outil de cartographie ne doit jamais
empêcher un service de booter.

Rien à configurer dans le cas courant : l'agent détecte s'il est dans une application web
et choisit le transport. Côté job, `MANIFEST_PORTS` sonde `8080` puis `8081`.

---

## 9. Dépannage

| Symptôme | Cause la plus probable |
|---|---|
| `manifest-unreachable` sur tous les services | L'agent n'est pas encore déployé — normal avant la partie 3 |
| `unknown-consumer` en masse | Un namespace manque dans `K8S_NAMESPACES` |
| Services nommés bizarrement | Vos labels diffèrent — ajustez `K8S_NAME_LABELS` |
| Tout en `unknown` dans la colonne Nature | Vos routing keys ne commencent pas par `evt.`/`cmd.` — ajustez `EVENT_PREFIXES` |
| `API management RabbitMQ … → 401` | Mauvais identifiants, ou utilisateur sans tag `monitoring` |
| `API management RabbitMQ … → 404` | Plugin `rabbitmq_management` désactivé, ou mauvais port |
| `publishes` vide malgré les annotations | `mvn clean` puis rebuild — le processeur n'a pas tourné |
| La carte « clignote » d'un run à l'autre | Scan lancé pendant un rolling update — augmentez `STALE_AFTER_RUNS` |
| Le job dépasse `activeDeadlineSeconds` | Trop de namespaces scannés — restreignez `K8S_NAMESPACES` |

Pour tout diagnostic, les logs du job listent les 8 étapes avec leurs compteurs :

```bash
kubectl logs -n platform job/event-map-discovery-run
```

---

## 10. Tenue en charge

Mesuré sur un système synthétique de **26 services** (20 workers + 6 APIs), 146 queues,
146 bindings, 337 consommateurs, 122 publications déclarées — dont deux consommateurs
transverses bindés en `evt.#`, le pire cas pour la densité d'arêtes.

Résultat : **492 flux résolus, pipeline complet en ~1,5 à 3 s.**

| Étage | Temps |
|---|---|
| Corrélation + tri déterministe | 40 ms |
| Merge + diff contre le run précédent | 7 ms |
| Matrice (sériation comprise) + catalogue | 17 ms |
| Layout des vues globales | 1 400 – 3 000 ms |
| 26 vues ego | 330 ms |
| Rendus drawio + viewer + rapport | 26 ms |

Deux points appris en mesurant.

**Le placement `NETWORK_SIMPLEX` d'ELK coûte 40 à 50× son alternative** — 11,4 s contre
0,2 s sur la vue détaillée — pour un graphe 2,2× plus compact. Le job garde donc le
placement soigné sur les petites vues et bascule sur `BRANDES_KOEPF` au-delà de
`LAYOUT_MAX_EXACT_NODES`.

**elkjs est mono-thread** (du Java compilé en JS). Les vues sont calculées
séquentiellement : un `Promise.all` ne gagnait rien et rendait les durées mesurées
inexploitables.

Le `REPORT.md` est plafonné à 40 entrées par section — sans ce garde-fou il atteignait
72 Ko, au-delà de la limite de 65 536 octets d'un corps de PR GitHub.

---

## 11. Ce que l'outil ne sait pas faire

À lire avant de faire confiance à la carte.

**C'est un instantané.** Un worker scale-to-zéro, ou dont les consommateurs sont
déconnectés au moment du scan, sort de la topologie observée. Le job applique donc un TTL
(`STALE_AFTER_RUNS`, défaut 3) : une arête absente survit plusieurs runs, marquée
`missingRuns`, avant d'être retirée. Sans ce sursis, la carte clignote et le diff devient
illisible.

**Les routing keys dynamiques restent approximatives.** Une clé du type
`"evt.order." + status` ne peut pas être résolue à la compilation. Voir les deux niveaux
de l'étape 3.3.

**Les topologies de retry/DLQ sont filtrées par convention de nommage.** Si vos noms
sortent des motifs par défaut, elles noieront le graphe. Ajustez `DLQ_PATTERNS` et
`RETRY_PATTERNS` plutôt que de subir.

**Le job ne voit qu'un vhost à la fois** (`RABBIT_VHOST`). Un système multi-vhost demande
un run par vhost.

**Seul l'exchange topic est modélisé.** Les exchanges direct, fanout et headers sont
collectés mais leurs bindings ne participent pas à la résolution des flux.

---

## 12. Développement

```bash
npm install && npm run build
```

| Commande | |
|---|---|
| `npm run build` | Compile TypeScript vers `dist/` |
| `npm run typecheck` | Vérification de types sans émission |
| `npm run try` | Essai local guidé contre un cluster |
| `npm run setup` | Génère les manifestes Kubernetes |
| `npm start` | Lance la découverte avec la configuration de l'environnement |

### Où regarder

| Fichier | |
|---|---|
| [src/core/amqp.ts](src/core/amqp.ts) | Le matching topic AMQP — programmation dynamique **au mot** plutôt qu'une traduction en regex, parce que `#` matche zéro ou plusieurs mots : `a.#` matche `a` tout court, cas que `^a\..*$` rate silencieusement |
| [src/core/correlate.ts](src/core/correlate.ts) | Assemblage de l'IR et détection des anomalies |
| [src/core/seriate.ts](src/core/seriate.ts) | Sériation de la matrice |
| [src/core/layout.ts](src/core/layout.ts) | Layouts ELK et arbitrage compacité/vitesse |
| [agent/](agent/) | L'agent Java — annotation, processeur, endpoint |

### Structure

```
src/
  collectors/   kubernetes · rabbitmq · manifest
  core/         amqp · correlate · merge · diff · matrix · seriate · ego · eventcatalog · layout
  renderers/    viewer · drawio
  outputs/      git
agent/          lib Spring Boot (publiée séparément)
deploy/         rbac · cronjob (gabarits versionnés)
scripts/        try · setup
```
