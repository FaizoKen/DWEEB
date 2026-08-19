import { describe, expect, it } from "vitest";
import { readClientParam, withClientParams, withoutClientParams } from "./clientParams";

describe("SEO client-only URL state", () => {
  it("reads fragments while retaining legacy query compatibility", () => {
    expect(readClientParam("template", "", "#template=welcome&entry=template%3Awelcome")).toBe(
      "welcome",
    );
    expect(readClientParam("template", "?template=rules", "#template=welcome")).toBe("rules");
  });

  it("moves generated app state out of crawlable query strings", () => {
    expect(
      withClientParams("/?template=announcement&intent=schedule", {
        entry: "feature:schedule-discord-messages",
      }),
    ).toBe("/#template=announcement&intent=schedule&entry=feature%3Aschedule-discord-messages");
    expect(
      withClientParams("https://dweeb.faizo.net/?template=welcome", {
        entry: "template:discord-welcome-message",
      }),
    ).toBe("https://dweeb.faizo.net/#template=welcome&entry=template%3Adiscord-welcome-message");
  });

  it("removes only requested values from query and fragment state", () => {
    expect(
      withoutClientParams(
        "https://dweeb.faizo.net/?entry=guide%3Aold&mode=edit#intent=json&entry=guide%3Anew&draft=1",
        ["entry"],
      ),
    ).toBe("/?mode=edit#intent=json&draft=1");
    expect(withoutClientParams("https://dweeb.faizo.net/#draft", ["entry"])).toBe("/#draft");
  });
});
