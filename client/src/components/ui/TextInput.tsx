import { forwardRef, useId, type InputHTMLAttributes } from "react";

import styles from "./TextInput.module.css";

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string | null;
  mono?: boolean;
}

/**
 * Labeled text input primitive. Uses useId for a stable htmlFor binding
 * and promotes the wrap element as the focus ring target so any overlay
 * icon we add later automatically sits inside the visible focused border.
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(
    { label, hint, error, mono, id, className, ...rest },
    ref,
  ) {
    const autoId = useId();
    const fieldId = id ?? autoId;
    const hintText = error ?? hint;

    return (
      <div className={styles.field}>
        {label ? (
          <label htmlFor={fieldId} className={styles.label}>
            {label}
          </label>
        ) : null}
        <div className={styles.wrap}>
          <input
            ref={ref}
            id={fieldId}
            className={`${styles.input} ${mono ? styles.inputMono : ""} ${className ?? ""}`}
            aria-invalid={error ? true : undefined}
            {...rest}
          />
        </div>
        {hintText ? (
          <p className={`${styles.hint} ${error ? styles.hintError : ""}`}>
            {hintText}
          </p>
        ) : null}
      </div>
    );
  },
);
