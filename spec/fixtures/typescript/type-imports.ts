import type { ExplicitType } from "./missing-explicit-type";
import { InferredType } from "./missing-inferred-type";

const result: ExplicitType & InferredType = { value: 42 };
export = result;
