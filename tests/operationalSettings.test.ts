import { describe, expect, it } from "vitest";
import { defaultOperationalSettings, parseOperationalSettings } from "../src/config/operationalSettings.js";

describe("operational settings compatibility", () => {
  it("converts the legacy republication delay from days to minutes", () => {
    const settings = parseOperationalSettings({ minDaysBeforeRepublish: 3 });

    expect(settings.republishIntervalMinutes).toBe(4_320);
    expect("minDaysBeforeRepublish" in settings).toBe(false);
  });

  it("preserves the legacy unlimited republication setting", () => {
    expect(parseOperationalSettings({ minDaysBeforeRepublish: null }).republishIntervalMinutes).toBeNull();
  });

  it("uses the previous seven-day default in minutes", () => {
    expect(defaultOperationalSettings().republishIntervalMinutes).toBe(10_080);
  });
});
