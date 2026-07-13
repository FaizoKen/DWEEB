import "react";

// `inert` is supported by all browsers in DWEEB's target set, but the React
// 18 type package used by the app predates its HTMLAttributes declaration.
declare module "react" {
  interface HTMLAttributes<T> {
    inert?: boolean;
  }
}
