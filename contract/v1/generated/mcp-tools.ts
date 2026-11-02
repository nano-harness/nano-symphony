// To parse this data:
//
//   import { Convert, MCPTools } from "./file";
//
//   const mCPTools = Convert.toMCPTools(json);
//
// These functions will throw an error if the JSON doesn't
// match the expected interface, even if the JSON is valid.

/**
 * JSON-RPC tool definitions exposed by nano-symphony's MCP server.
 */
export interface MCPTools {
    /**
     * Emit a structured result conforming to the issue's expected_schema.
     */
    "symphony.emit_result"?: any;
    /**
     * Fetch the current issue context, attempt number, and previous invocations.
     */
    "symphony.fetch_issue"?: any;
    /**
     * Report a progress event. Payload must be <= 64KB.
     */
    "symphony.report_event"?: any;
    /**
     * Report goal evaluation progress.
     */
    "symphony.report_goal_state"?: any;
    /**
     * Required end-of-session signal.
     */
    "symphony.session_completed"?: any;
    /**
     * Spawn a new plan run asynchronously.
     */
    "symphony.spawn_plan_run"?: any;
    /**
     * Spawn a plan run and hand off the current issue until it completes.
     */
    "symphony.spawn_plan_run_and_handoff"?: any;
    /**
     * Submit an implementation plan. Only allowed when the issue is in 'planning' state.
     */
    "symphony.submit_plan"?: any;
    [property: string]: any;
}

// Converts JSON strings to/from your types
// and asserts the results of JSON.parse at runtime
export class Convert {
    public static toMCPTools(json: string): MCPTools {
        return cast(JSON.parse(json), r("MCPTools"));
    }

    public static mCPToolsToJson(value: MCPTools): string {
        return JSON.stringify(uncast(value, r("MCPTools")), null, 2);
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
    "MCPTools": o([
        { json: "symphony.emit_result", js: "symphony.emit_result", typ: u(undefined, "any") },
        { json: "symphony.fetch_issue", js: "symphony.fetch_issue", typ: u(undefined, "any") },
        { json: "symphony.report_event", js: "symphony.report_event", typ: u(undefined, "any") },
        { json: "symphony.report_goal_state", js: "symphony.report_goal_state", typ: u(undefined, "any") },
        { json: "symphony.session_completed", js: "symphony.session_completed", typ: u(undefined, "any") },
        { json: "symphony.spawn_plan_run", js: "symphony.spawn_plan_run", typ: u(undefined, "any") },
        { json: "symphony.spawn_plan_run_and_handoff", js: "symphony.spawn_plan_run_and_handoff", typ: u(undefined, "any") },
        { json: "symphony.submit_plan", js: "symphony.submit_plan", typ: u(undefined, "any") },
    ], "any"),
};
