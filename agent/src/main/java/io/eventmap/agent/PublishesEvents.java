package io.eventmap.agent;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** Conteneur permettant de répéter {@link PublishesEvent} sur un même élément. */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target({ ElementType.METHOD, ElementType.TYPE })
public @interface PublishesEvents {
    PublishesEvent[] value();
}
