import { customAlphabet } from "nanoid";

/**
 * Editor-only id generator. 10 characters from a URL-safe alphabet is enough
 * to make collisions astronomically unlikely within a single message (largest
 * legal message is 40 components).
 */
const generate = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export const newId = (): string => generate();
