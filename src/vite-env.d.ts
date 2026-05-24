/// <reference types="vite/client" />

// Treat default-imported CSS Modules as a string->string lookup so e.g.
// `import styles from "./Foo.module.css"; styles.bar` type-checks.
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
