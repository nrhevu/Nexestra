import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(" ");

/* ------------------------------------------------------------------- Pane */

export interface PaneProps {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** Drop the outer border, e.g. when the parent already draws one. */
  flush?: boolean;
  /** Remove body padding, e.g. for lists and editors. */
  bodyFlush?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Titled box with a 1px border — the basic building block of every surface. */
export function Pane({
  title,
  actions,
  children,
  flush = false,
  bodyFlush = false,
  className,
  style,
}: PaneProps) {
  return (
    <section className={cx("nx-pane", flush && "nx-pane--flush", className)} style={style}>
      {(title || actions) && (
        <header className="nx-pane__head">
          {title ? <span className="nx-pane__title">{title}</span> : null}
          {actions ? <span className="nx-pane__actions">{actions}</span> : null}
        </header>
      )}
      <div className={cx("nx-pane__body", bodyFlush && "nx-pane__body--flush")}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------- Rail */

export interface RailItem {
  id: string;
  label: string;
  title?: string;
}

export interface RailProps {
  items: readonly RailItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  footer?: ReactNode;
  children?: ReactNode;
}

/** The 48px vertical workspace rail on the far left of the shell. */
export function Rail({ items, activeId, onSelect, footer, children }: RailProps) {
  return (
    <nav className="nx-rail" aria-label="Workspaces">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="nx-rail__item"
          aria-current={item.id === activeId}
          title={item.title ?? item.label}
          onClick={() => onSelect?.(item.id)}
        >
          {item.label}
        </button>
      ))}
      {children}
      <span className="nx-rail__spacer" />
      {footer}
    </nav>
  );
}

/* -------------------------------------------------------------------- Kbd */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="nx-kbd">{children}</kbd>;
}

/* ---------------------------------------------------------------- KeyHint */

export interface KeyHintProps {
  keys: readonly string[];
  label?: ReactNode;
}

/** `⌘ K  command palette` — a keycap group followed by its description. */
export function KeyHint({ keys, label }: KeyHintProps) {
  return (
    <span className="nx-keyhint">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
      {label ? <span className="nx-keyhint__label">{label}</span> : null}
    </span>
  );
}

/* -------------------------------------------------------------- StatusDot */

export type StatusTone = "idle" | "running" | "done" | "warn" | "error";

export function StatusDot({ tone, label }: { tone: StatusTone; label?: ReactNode }) {
  return (
    <span className={cx("nx-dot", `nx-dot--${tone}`)}>
      <span className="nx-dot__mark" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

/* -------------------------------------------------------------------- Tag */

export type TagTone = "default" | "accent" | "info" | "warn" | "danger" | "magenta";

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: TagTone;
  children: ReactNode;
}

export function Tag({ tone = "default", className, children, ...rest }: TagProps) {
  return (
    <span className={cx("nx-tag", tone !== "default" && `nx-tag--${tone}`, className)} {...rest}>
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------- Button */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Render the label inside `[ ]` brackets, TUI style. */
  bracket?: boolean;
  tone?: "default" | "primary" | "danger";
  boxed?: boolean;
}

export function Button({
  bracket = true,
  tone = "default",
  boxed = false,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "nx-button",
        tone !== "default" && `nx-button--${tone}`,
        boxed && "nx-button--boxed",
        className,
      )}
      {...rest}
    >
      {bracket ? <span className="nx-button__bracket">[</span> : null}
      <span>{children}</span>
      {bracket ? <span className="nx-button__bracket">]</span> : null}
    </button>
  );
}

/* ----------------------------------------------------------------- Select */

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: readonly SelectOption[];
  label?: string;
}

export function Select({ options, label, className, id, ...rest }: SelectProps) {
  const select = (
    <select className={cx("nx-select", className)} id={id} {...rest}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
  if (!label) return select;
  return (
    <label className="nx-field" htmlFor={id}>
      <span className="nx-field__label">{label}</span>
      {select}
    </label>
  );
}

/* ------------------------------------------------------------------ Input */

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function TextInput({ label, className, id, ...rest }: TextInputProps) {
  const input = <input className={cx("nx-input", className)} id={id} {...rest} />;
  if (!label) return input;
  return (
    <label className="nx-field" htmlFor={id}>
      <span className="nx-field__label">{label}</span>
      {input}
    </label>
  );
}

/* --------------------------------------------------------------- Checkbox */

export interface CheckboxProps {
  checked: boolean;
  label: ReactNode;
  hint?: ReactNode;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
}

/** `[x] Label` / `[ ] Label` — TUI styling over a real checkbox input. */
export function Checkbox({ checked, label, hint, onChange, disabled = false }: CheckboxProps) {
  return (
    <label className="nx-check">
      <input
        type="checkbox"
        className="nx-check__input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      <span className="nx-check__box">{checked ? "[x]" : "[ ]"}</span>
      <span className="nx-check__label">{label}</span>
      {hint ? <span className="nx-check__hint">{hint}</span> : null}
    </label>
  );
}

/* -------------------------------------------------------------- MonoTable */

export interface MonoTableColumn<Row> {
  key: string;
  header: ReactNode;
  width?: string;
  render: (row: Row) => ReactNode;
}

export interface MonoTableProps<Row> {
  columns: readonly MonoTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  empty?: ReactNode;
}

/** Dense key/value or record table with monospace alignment. */
export function MonoTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty = "— nothing here —",
}: MonoTableProps<Row>) {
  if (rows.length === 0) return <div className="nx-muted">{empty}</div>;
  return (
    <table className="nx-table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} style={column.width ? { width: column.width } : undefined}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            style={onRowClick ? { cursor: "pointer" } : undefined}
          >
            {columns.map((column) => (
              <td key={column.key}>{column.render(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* --------------------------------------------------------------- Composer */

export interface ComposerProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "ref"> {
  /** Rendered to the right of the textarea, e.g. the `[>]` send button. */
  action?: ReactNode;
  /** Hint line under the input: `@agent  #ref  /command`. */
  hints?: ReactNode;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

export function Composer({ action, hints, textareaRef, className, ...rest }: ComposerProps) {
  return (
    <div className="nx-composer">
      <div className="nx-composer__row">
        <textarea
          ref={textareaRef}
          className={cx("nx-textarea", "nx-composer__input", className)}
          rows={2}
          {...rest}
        />
        {action}
      </div>
      {hints ? <div className="nx-composer__hints">{hints}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Divider */

export function Divider() {
  return <div className="nx-divider" />;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="nx-section-label">{children}</div>;
}
