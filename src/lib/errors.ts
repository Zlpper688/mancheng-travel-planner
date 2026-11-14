export class TravelError extends Error {
  code: string;
  hint?: string;

  constructor(message: string, code = "PLAN_FAILED", hint?: string) {
    super(message);
    this.name = "TravelError";
    this.code = code;
    this.hint = hint;
  }
}
