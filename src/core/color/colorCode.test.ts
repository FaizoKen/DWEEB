import { describe, expect, it } from "vitest";
import { colorFormats, parseColorInput, readableOn } from "./colorCode";

const BLURPLE = 0x5865f2;

describe("parseColorInput", () => {
  it("reads every form the same color is pasted in", () => {
    for (const input of [
      "#5865F2",
      "#5865f2",
      "0x5865F2",
      "5865F2",
      "5793266",
      "rgb(88, 101, 242)",
      "88, 101, 242",
      "88 101 242",
      "  #5865F2  ",
    ]) {
      expect(parseColorInput(input), input).toBe(BLURPLE);
    }
  });

  it("expands three-digit hex", () => {
    expect(parseColorInput("#fff")).toBe(0xffffff);
    expect(parseColorInput("0x0f0")).toBe(0x00ff00);
  });

  it("reads a bare all-digit run as decimal, not hex", () => {
    // "123456" is a decimal color in a JSON body, never #123456.
    expect(parseColorInput("123456")).toBe(123456);
    expect(parseColorInput("0")).toBe(0);
  });

  it("refuses values Discord would not accept", () => {
    for (const input of ["", "#12345", "#1234567", "16777216", "rgb(256, 0, 0)", "blurple", "-1"]) {
      expect(parseColorInput(input), input).toBeNull();
    }
    expect(parseColorInput("16777215")).toBe(0xffffff);
  });
});

describe("colorFormats", () => {
  it("writes the hex, decimal, literal and rgb forms", () => {
    expect(colorFormats(BLURPLE)).toEqual({
      hex: "#5865F2",
      decimal: "5793266",
      literal: "0x5865F2",
      rgb: "rgb(88, 101, 242)",
    });
  });

  it("pads small values and clamps out-of-range ones", () => {
    expect(colorFormats(0x00ff).hex).toBe("#0000FF");
    expect(colorFormats(-5).decimal).toBe("0");
    expect(colorFormats(0x1ffffff).hex).toBe("#FFFFFF");
  });
});

describe("readableOn", () => {
  it("picks dark text on light colors and light text on dark ones", () => {
    expect(readableOn(0xfee75c)).toBe("#000000");
    expect(readableOn(0xffffff)).toBe("#000000");
    expect(readableOn(0x23272a)).toBe("#ffffff");
    expect(readableOn(BLURPLE)).toBe("#ffffff");
  });
});
