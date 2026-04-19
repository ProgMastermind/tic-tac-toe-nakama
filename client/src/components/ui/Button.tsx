import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "accent";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

/**
 * Minimal button primitive. Variants express intent (primary, secondary,
 * ghost, accent). Loading state swaps children for a spinner without
 * changing the button's measured width — prevents layout jitter when a
 * form posts.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    block,
    loading,
    leadingIcon,
    trailingIcon,
    disabled,
    className,
    children,
    type = "button",
    ...rest
  },
  ref,
) {
  const classes = [
    styles.button,
    styles[variant],
    size === "sm" ? styles.sizeSm : size === "lg" ? styles.sizeLg : "",
    block ? styles.block : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={classes}
      {...rest}
    >
      {loading ? (
        <span className={styles.spinner} aria-hidden />
      ) : (
        leadingIcon && <span aria-hidden>{leadingIcon}</span>
      )}
      <span>{children}</span>
      {!loading && trailingIcon ? <span aria-hidden>{trailingIcon}</span> : null}
    </button>
  );
});
