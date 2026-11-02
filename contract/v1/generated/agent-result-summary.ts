// To parse this data:
//
//   import { Convert, AgentResultSummary } from "./file";
//
//   const agentResultSummary = Convert.toAgentResultSummary(json);
//
// These functions will throw an error if the JSON doesn't
// match the expected interface, even if the JSON is valid.

/**
 * Contract payload emitted by an agent process as the last line of stdout and written to
 * result.json.
 */
export interface AgentResultSummary {
    /**
     * Sample of commands blocked by the permission system.
     */
    blocked_commands_sample?: string[];
    /**
     * Stable identifier for a retryable blocker, used for short-circuit detection.
     */
    blocker_fingerprint?: string;
    /**
     * Optional cache key used to correlate retries.
     */
    cache_key?: string;
    /**
     * Wall-clock duration of the run in milliseconds.
     */
    duration_ms?: number;
    goal_state?:  GoalState;
    /**
     * Human-readable summary of the outcome.
     */
    reason?:  string;
    sandbox?: Sandbox;
    /**
     * Completion semantics of the agent run.
     */
    status: Status;
    /**
     * Structured enum describing why the run ended.
     */
    termination_cause?: string;
    tokens?:            Tokens;
    /**
     * Total number of tool calls made during the run.
     */
    tool_calls?: number;
    [property: string]: any;
}

export interface GoalState {
    achieved_at?:     Date;
    active?:          boolean;
    condition?:       string;
    last_reason?:     string;
    max_turns?:       number;
    turns_evaluated?: number;
    [property: string]: any;
}

export interface Sandbox {
    backend?: string;
    enabled?: boolean;
    network?: string;
    [property: string]: any;
}

/**
 * Completion semantics of the agent run.
 */
export enum Status {
    Abandoned = "abandoned",
    NeedsRetry = "needs_retry",
    Success = "success",
    Timeout = "timeout",
}

export interface Tokens {
    cached?: number;
    input?:  number;
    output?: number;
    total?:  number;
    [property: string]: any;
}

// Converts JSON strings to/from your types
// and asserts the results of JSON.parse at runtime
export class Convert {
    public static toAgentResultSummary(json: string): AgentResultSummary {
        return cast(JSON.parse(json), r("AgentResultSummary"));
    }

    public static agentResultSummaryToJson(value: AgentResultSummary): string {
        return JSON.stringify(uncast(value, r("AgentResultSummary")), null, 2);
    }
}

function invalidValue(typ: any, val: any, key: any, parent: any = ''): never {
    const prettyTyp = prettyTypeName(typ);
    const parentText = parent ? ` on ${parent}` : '';
    const keyText = key ? ` for key "${key}"` : '';
    throw Error(`Invalid value${keyText}${parentText}. Expected ${prettyTyp} but got ${JSON.stringify(val)}`);
}

function prettyTypeName(typ: any): string {
    if (Array.isArray(typ)) {
        if (typ.length === 2 && typ[0] === undefined) {
            return `an optional ${prettyTypeName(typ[1])}`;
        } else {
            return `one of [${typ.map(a => { return prettyTypeName(a); }).join(", ")}]`;
        }
    } else if (typeof typ === "object" && typ.literal !== undefined) {
        return typ.literal;
    } else {
        return typeof typ;
    }
}

function jsonToJSProps(typ: any): any {
    if (typ.jsonToJS === undefined) {
        const map: any = {};
        typ.props.forEach((p: any) => map[p.json] = { key: p.js, typ: p.typ });
        typ.jsonToJS = map;
    }
    return typ.jsonToJS;
}

function jsToJSONProps(typ: any): any {
    if (typ.jsToJSON === undefined) {
        const map: any = {};
        typ.props.forEach((p: any) => map[p.js] = { key: p.json, typ: p.typ });
        typ.jsToJSON = map;
    }
    return typ.jsToJSON;
}

function transform(val: any, typ: any, getProps: any, key: any = '', parent: any = ''): any {
    function transformPrimitive(typ: string, val: any): any {
        if (typeof typ === typeof val) return val;
        return invalidValue(typ, val, key, parent);
    }

    function transformUnion(typs: any[], val: any): any {
        // val must validate against one typ in typs
        const l = typs.length;
        for (let i = 0; i < l; i++) {
            const typ = typs[i];
            try {
                return transform(val, typ, getProps);
            } catch (_) {}
        }
        return invalidValue(typs, val, key, parent);
    }

    function transformEnum(cases: string[], val: any): any {
        if (cases.indexOf(val) !== -1) return val;
        return invalidValue(cases.map(a => { return l(a); }), val, key, parent);
    }

    function transformArray(typ: any, val: any): any {
        // val must be an array with no invalid elements
        if (!Array.isArray(val)) return invalidValue(l("array"), val, key, parent);
        return val.map(el => transform(el, typ, getProps));
    }

    function transformDate(val: any): any {
        if (val === null) {
            return null;
        }
        const d = new Date(val);
        if (isNaN(d.valueOf())) {
            return invalidValue(l("Date"), val, key, parent);
        }
        return d;
    }

    function transformObject(props: { [k: string]: any }, additional: any, val: any): any {
        if (val === null || typeof val !== "object" || Array.isArray(val)) {
            return invalidValue(l(ref || "object"), val, key, parent);
        }
        const result: any = {};
        Object.getOwnPropertyNames(props).forEach(key => {
            const prop = props[key];
            const v = Object.prototype.hasOwnProperty.call(val, key) ? val[key] : undefined;
            result[prop.key] = transform(v, prop.typ, getProps, key, ref);
        });
        Object.getOwnPropertyNames(val).forEach(key => {
            if (!Object.prototype.hasOwnProperty.call(props, key)) {
                result[key] = transform(val[key], additional, getProps, key, ref);
            }
        });
        return result;
    }

    if (typ === "any") return val;
    if (typ === null) {
        if (val === null) return val;
        return invalidValue(typ, val, key, parent);
    }
    if (typ === false) return invalidValue(typ, val, key, parent);
    let ref: any = undefined;
    while (typeof typ === "object" && typ.ref !== undefined) {
        ref = typ.ref;
        typ = typeMap[typ.ref];
    }
    if (Array.isArray(typ)) return transformEnum(typ, val);
    if (typeof typ === "object") {
        return typ.hasOwnProperty("unionMembers") ? transformUnion(typ.unionMembers, val)
            : typ.hasOwnProperty("arrayItems")    ? transformArray(typ.arrayItems, val)
            : typ.hasOwnProperty("props")         ? transformObject(getProps(typ), typ.additional, val)
            : invalidValue(typ, val, key, parent);
    }
    // Numbers can be parsed by Date but shouldn't be.
    if (typ === Date && typeof val !== "number") return transformDate(val);
    return transformPrimitive(typ, val);
}

function cast<T>(val: any, typ: any): T {
    return transform(val, typ, jsonToJSProps);
}

function uncast<T>(val: T, typ: any): any {
    return transform(val, typ, jsToJSONProps);
}

function l(typ: any) {
    return { literal: typ };
}

function a(typ: any) {
    return { arrayItems: typ };
}

function u(...typs: any[]) {
    return { unionMembers: typs };
}

function o(props: any[], additional: any) {
    return { props, additional };
}

function m(additional: any) {
    return { props: [], additional };
}

function r(name: string) {
    return { ref: name };
}

const typeMap: any = {
    "AgentResultSummary": o([
        { json: "blocked_commands_sample", js: "blocked_commands_sample", typ: u(undefined, a("")) },
        { json: "blocker_fingerprint", js: "blocker_fingerprint", typ: u(undefined, "") },
        { json: "cache_key", js: "cache_key", typ: u(undefined, "") },
        { json: "duration_ms", js: "duration_ms", typ: u(undefined, 0) },
        { json: "goal_state", js: "goal_state", typ: u(undefined, r("GoalState")) },
        { json: "reason", js: "reason", typ: u(undefined, "") },
        { json: "sandbox", js: "sandbox", typ: u(undefined, r("Sandbox")) },
        { json: "status", js: "status", typ: r("Status") },
        { json: "termination_cause", js: "termination_cause", typ: u(undefined, "") },
        { json: "tokens", js: "tokens", typ: u(undefined, r("Tokens")) },
        { json: "tool_calls", js: "tool_calls", typ: u(undefined, 0) },
    ], "any"),
    "GoalState": o([
        { json: "achieved_at", js: "achieved_at", typ: u(undefined, Date) },
        { json: "active", js: "active", typ: u(undefined, true) },
        { json: "condition", js: "condition", typ: u(undefined, "") },
        { json: "last_reason", js: "last_reason", typ: u(undefined, "") },
        { json: "max_turns", js: "max_turns", typ: u(undefined, 0) },
        { json: "turns_evaluated", js: "turns_evaluated", typ: u(undefined, 0) },
    ], "any"),
    "Sandbox": o([
        { json: "backend", js: "backend", typ: u(undefined, "") },
        { json: "enabled", js: "enabled", typ: u(undefined, true) },
        { json: "network", js: "network", typ: u(undefined, "") },
    ], "any"),
    "Tokens": o([
        { json: "cached", js: "cached", typ: u(undefined, 0) },
        { json: "input", js: "input", typ: u(undefined, 0) },
        { json: "output", js: "output", typ: u(undefined, 0) },
        { json: "total", js: "total", typ: u(undefined, 0) },
    ], "any"),
    "Status": [
        "abandoned",
        "needs_retry",
        "success",
        "timeout",
    ],
};
