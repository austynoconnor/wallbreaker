import { expect, it } from "vitest";
import { eventFromUnknown } from "../v2/api";

it("makes a queued execution's saved error visible in Live", () => {
  const message = "AttributeError: 'dict' object has no attribute 'model_dump'";
  const event = eventFromUnknown({ kind: "error", sequence: 3, data: { error: message } }, "run", 0);
  expect(event.text).toBe(message);
  expect(event.raw).toEqual({ kind: "error", sequence: 3, data: { error: message } });
});
