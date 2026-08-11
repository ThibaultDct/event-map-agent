package io.eventmap.agent;

import javax.annotation.processing.ProcessingEnvironment;
import javax.lang.model.element.AnnotationMirror;
import javax.lang.model.element.AnnotationValue;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.ArrayType;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.util.ElementFilter;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Aplatit la structure d'une classe de payload en une liste de chemins typés.
 *
 * <p>C'est ce qui permet au job de détecter une <em>rupture de contrat</em> : un
 * champ disparu ou dont le type change casse les consommateurs, et la carte sait
 * déjà exactement qui ils sont. Sans schéma, l'outil répond « qui consomme cet
 * événement » ; avec, il répond « si je modifie ce payload, qui casse ».
 *
 * <p>Le résultat est volontairement <b>plat</b> plutôt qu'arborescent :
 *
 * <pre>
 *   orderId          java.util.UUID
 *   customer.id      java.lang.String
 *   lines[]          com.acme.OrderLine
 *   lines[].sku      java.lang.String
 *   status           enum[CREATED,PAID,CANCELLED]
 * </pre>
 *
 * Comparer deux versions se réduit alors à une différence d'ensembles sur les
 * chemins, et le message d'alerte se lit tel quel — là où un diff d'arbre
 * demanderait un parcours et une mise en forme.
 *
 * <p><b>Limite assumée.</b> On lit les <em>champs</em>, alors que Jackson
 * sérialise par défaut les <em>accesseurs</em>. Pour un record, une classe
 * Lombok {@code @Data} ou un POJO ordinaire les deux coïncident ; pour une classe
 * dont un getter calcule une valeur sans champ correspondant, la propriété sera
 * absente du schéma. {@code @JsonIgnore} et {@code @JsonProperty} sont en
 * revanche pris en compte.
 */
final class SchemaExtractor {

    /** Au-delà, on cesse de descendre : un graphe d'objets profond n'apporte plus rien. */
    private static final int MAX_DEPTH = 4;

    /** Types traités comme des valeurs : on ne descend jamais dedans. */
    private static final Set<String> LEAF = Set.of(
            "java.lang.String", "java.lang.Boolean", "java.lang.Byte", "java.lang.Short",
            "java.lang.Integer", "java.lang.Long", "java.lang.Float", "java.lang.Double",
            "java.lang.Character", "java.lang.Number", "java.lang.Object", "java.lang.Class",
            "java.math.BigDecimal", "java.math.BigInteger", "java.util.UUID", "java.util.Date",
            "java.util.Currency", "java.util.Locale", "java.net.URI", "java.net.URL",
            "java.time.Instant", "java.time.LocalDate", "java.time.LocalTime",
            "java.time.LocalDateTime", "java.time.OffsetDateTime", "java.time.ZonedDateTime",
            "java.time.Duration", "java.time.Period", "java.time.Year", "java.time.YearMonth");

    /** Un champ du payload : son chemin depuis la racine, et son type. */
    record Field(String path, String type) { }

    private final Types types;
    private final Elements elements;

    SchemaExtractor(ProcessingEnvironment env) {
        this.types = env.getTypeUtils();
        this.elements = env.getElementUtils();
    }

    List<Field> extract(TypeMirror payload) {
        List<Field> out = new ArrayList<>();
        walk(payload, "", 0, new LinkedHashSet<>(), out);
        return out;
    }

    private void walk(TypeMirror type, String prefix, int depth, Set<String> onPath, List<Field> out) {
        TypeElement te = asTypeElement(type);
        if (te == null || depth > MAX_DEPTH) {
            return;
        }
        String fqn = te.getQualifiedName().toString();
        // Un événement peut contenir une référence circulaire (parent ↔ enfant) :
        // sans ce garde-fou le processeur boucle jusqu'au StackOverflow.
        if (!onPath.add(fqn)) {
            return;
        }

        for (VariableElement field : declaredFields(te)) {
            if (skip(field)) {
                continue;
            }
            String name = jsonName(field);
            String path = prefix.isEmpty() ? name : prefix + "." + name;
            emit(unwrapOptional(field.asType()), path, depth, onPath, out);
        }

        onPath.remove(fqn);
    }

    /** Écrit une entrée pour ce champ, et descend dedans si c'est une structure. */
    private void emit(TypeMirror type, String path, int depth, Set<String> onPath, List<Field> out) {
        TypeMirror element = elementTypeOf(type);
        if (element != null) {
            // Collection ou tableau : le suffixe `[]` porte la cardinalité, si
            // bien qu'un passage de `List<Foo>` à `Foo` apparaît comme un chemin
            // supprimé et un chemin ajouté — donc comme une rupture.
            out.add(new Field(path + "[]", describe(element)));
            // Le test de feuille vaut aussi ici : sans lui, un `String[]` fait
            // descendre dans les champs internes de java.lang.String.
            if (!isLeaf(element)) {
                walk(element, path + "[]", depth + 1, onPath, out);
            }
            return;
        }
        if (isMap(type)) {
            // Un dictionnaire est ouvert par nature : on note son existence et
            // son typage, sans prétendre en énumérer les clés.
            out.add(new Field(path + "{}", describe(type)));
            return;
        }
        out.add(new Field(path, describe(type)));
        if (!isLeaf(type)) {
            walk(type, path, depth + 1, onPath, out);
        }
    }

    /**
     * Représentation textuelle du type. Les énumérations exposent leurs
     * constantes : en retirer une casse les consommateurs, et cela doit donc
     * apparaître comme un changement de type.
     */
    private String describe(TypeMirror type) {
        if (type.getKind().isPrimitive()) {
            return type.toString();
        }
        TypeElement te = asTypeElement(type);
        if (te == null) {
            return type.toString();
        }
        if (te.getKind() == ElementKind.ENUM) {
            List<String> constants = new ArrayList<>();
            for (Element e : te.getEnclosedElements()) {
                if (e.getKind() == ElementKind.ENUM_CONSTANT) {
                    constants.add(e.getSimpleName().toString());
                }
            }
            return "enum[" + String.join(",", constants) + "]";
        }
        if (isMap(type) && type instanceof DeclaredType dt && dt.getTypeArguments().size() == 2) {
            return "Map<" + shorten(dt.getTypeArguments().get(0)) + ","
                    + shorten(dt.getTypeArguments().get(1)) + ">";
        }
        return te.getQualifiedName().toString();
    }

    private String shorten(TypeMirror t) {
        TypeElement te = asTypeElement(t);
        return te == null ? t.toString() : te.getSimpleName().toString();
    }

    /** Champs déclarés, y compris ceux hérités des classes parentes. */
    private List<VariableElement> declaredFields(TypeElement te) {
        List<VariableElement> out = new ArrayList<>();
        TypeElement current = te;
        while (current != null && !"java.lang.Object".equals(current.getQualifiedName().toString())) {
            out.addAll(ElementFilter.fieldsIn(current.getEnclosedElements()));
            current = asTypeElement(current.getSuperclass());
        }
        return out;
    }

    private boolean skip(VariableElement field) {
        Set<Modifier> mods = field.getModifiers();
        // `static` n'est pas de l'état d'instance ; `transient` est explicitement
        // exclu de la sérialisation. Les champs synthétiques (référence externe
        // d'une classe interne, instrumentation de couverture) n'existent pas
        // dans le JSON.
        if (mods.contains(Modifier.STATIC) || mods.contains(Modifier.TRANSIENT)) {
            return true;
        }
        String name = field.getSimpleName().toString();
        if (name.startsWith("$") || name.startsWith("this$")) {
            return true;
        }
        return hasAnnotation(field, "JsonIgnore");
    }

    /** Respecte {@code @JsonProperty("...")} sans dépendre de Jackson à la compilation. */
    private String jsonName(VariableElement field) {
        for (AnnotationMirror am : field.getAnnotationMirrors()) {
            if (!simpleName(am).equals("JsonProperty")) {
                continue;
            }
            for (Map.Entry<? extends ExecutableElement, ? extends AnnotationValue> e
                    : am.getElementValues().entrySet()) {
                if (e.getKey().getSimpleName().contentEquals("value")) {
                    Object v = e.getValue().getValue();
                    if (v != null && !v.toString().isBlank()) {
                        return v.toString();
                    }
                }
            }
        }
        return field.getSimpleName().toString();
    }

    private boolean hasAnnotation(Element el, String simpleName) {
        for (AnnotationMirror am : el.getAnnotationMirrors()) {
            if (simpleName(am).equals(simpleName)) {
                return true;
            }
        }
        return false;
    }

    private String simpleName(AnnotationMirror am) {
        return am.getAnnotationType().asElement().getSimpleName().toString();
    }

    /** Type des éléments si le type est un tableau ou une collection, sinon {@code null}. */
    private TypeMirror elementTypeOf(TypeMirror type) {
        if (type instanceof ArrayType at) {
            return at.getComponentType();
        }
        if (isAssignableTo(type, "java.util.Collection") && type instanceof DeclaredType dt) {
            List<? extends TypeMirror> args = dt.getTypeArguments();
            return args.isEmpty() ? elements.getTypeElement("java.lang.Object").asType() : args.get(0);
        }
        return null;
    }

    /** Jackson déballe {@code Optional<T>} : le schéma doit faire pareil. */
    private TypeMirror unwrapOptional(TypeMirror type) {
        if (type instanceof DeclaredType dt) {
            TypeElement te = asTypeElement(type);
            if (te != null && "java.util.Optional".equals(te.getQualifiedName().toString())
                    && !dt.getTypeArguments().isEmpty()) {
                return dt.getTypeArguments().get(0);
            }
        }
        return type;
    }

    private boolean isMap(TypeMirror type) {
        return isAssignableTo(type, "java.util.Map");
    }

    private boolean isAssignableTo(TypeMirror type, String fqn) {
        if (type.getKind() != TypeKind.DECLARED) {
            return false;
        }
        TypeElement target = elements.getTypeElement(fqn);
        return target != null && types.isAssignable(types.erasure(type), types.erasure(target.asType()));
    }

    private boolean isLeaf(TypeMirror type) {
        if (type.getKind().isPrimitive()) {
            return true;
        }
        TypeElement te = asTypeElement(type);
        if (te == null) {
            return true;
        }
        if (te.getKind() == ElementKind.ENUM) {
            return true;
        }
        String fqn = te.getQualifiedName().toString();
        // Tout ce qui vient du JDK est traité comme opaque : descendre dans les
        // entrailles de java.* ne documente rien d'utile sur le contrat métier.
        return LEAF.contains(fqn) || fqn.startsWith("java.") || fqn.startsWith("javax.");
    }

    private TypeElement asTypeElement(TypeMirror type) {
        if (type == null || type.getKind() != TypeKind.DECLARED) {
            return null;
        }
        Element el = types.asElement(type);
        return el instanceof TypeElement te ? te : null;
    }
}
