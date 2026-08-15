#!/usr/bin/env python3
"""
Skill evaluation tool for nano-symphony.

Scans every SKILL.md under skills/ and produces a structured report covering:
  - frontmatter (name / description presence and length)
  - document structure (headings, examples, code blocks)
  - internal link validity
  - cross-skill consistency (e.g. plan SDK surface mentioned in both skills)

Usage:
  python3 scripts/evaluate-skills.py
  python3 scripts/evaluate-skills.py --json > report.json
"""

import argparse
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

ROOT_DIR = Path(__file__).resolve().parent.parent
SKILLS_DIR = ROOT_DIR / "skills"


@dataclass
class Finding:
    file: str
    severity: str
    check: str
    message: str
    line: Optional[int] = None


@dataclass
class SkillReport:
    frontmatter: Optional[dict] = None
    findings: list = field(default_factory=list)
    score: int = 100


@dataclass
class Summary:
    total: int = 0
    errors: int = 0
    warnings: int = 0
    infos: int = 0


@dataclass
class Report:
    skills: dict = field(default_factory=dict)
    summary: Summary = field(default_factory=Summary)


def walk_skills():
    for path in SKILLS_DIR.rglob("SKILL.md"):
        if path.is_file():
            yield path


def parse_frontmatter(text: str) -> Optional[dict]:
    match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---", text)
    if not match:
        return None
    raw = match.group(1)
    result: dict = {}
    for line in raw.splitlines():
        if ":" not in line or line.startswith("#"):
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1]
        elif value.lower() == "true":
            value = True
        elif value.lower() == "false":
            value = False
        elif re.fullmatch(r"-?\d+", value):
            value = int(value)
        result[key] = value
    return result


def line_number(text: str, index: int) -> int:
    return text[:index].count("\n") + 1


def check_frontmatter(text: str, rel: str, findings: list) -> Optional[dict]:
    fm = parse_frontmatter(text)
    if fm is None:
        findings.append(
            Finding(
                file=rel,
                severity="error",
                check="frontmatter",
                message="Missing YAML frontmatter (expected --- ... --- at top of file)",
            )
        )
        return None

    name = fm.get("name")
    if not name or not isinstance(name, str) or not name.strip():
        findings.append(
            Finding(
                file=rel,
                severity="error",
                check="frontmatter.name",
                message="Frontmatter missing non-empty 'name' field",
            )
        )

    description = fm.get("description")
    if not description or not isinstance(description, str) or not description.strip():
        findings.append(
            Finding(
                file=rel,
                severity="error",
                check="frontmatter.description",
                message="Frontmatter missing non-empty 'description' field",
            )
        )
    else:
        if len(description) < 40:
            findings.append(
                Finding(
                    file=rel,
                    severity="warning",
                    check="frontmatter.description",
                    message=f"Description is short ({len(description)} chars); consider adding trigger conditions and scope",
                )
            )
        if len(description) > 500:
            findings.append(
                Finding(
                    file=rel,
                    severity="warning",
                    check="frontmatter.description",
                    message=f"Description is very long ({len(description)} chars); consider trimming for token efficiency",
                )
            )

    return fm


def check_structure(text: str, rel: str, findings: list):
    h1_count = len(re.findall(r"^#\s+", text, flags=re.MULTILINE))
    h2_count = len(re.findall(r"^##\s+", text, flags=re.MULTILINE))
    code_blocks = len(re.findall(r"^```[\s\S]*?^```", text, flags=re.MULTILINE))
    inline_code = len(re.findall(r"`[^`]+`", text))

    if h1_count == 0:
        findings.append(
            Finding(
                file=rel,
                severity="warning",
                check="structure.headings",
                message="No H1 heading found",
            )
        )
    if h2_count < 2:
        findings.append(
            Finding(
                file=rel,
                severity="warning",
                check="structure.headings",
                message=f"Only {h2_count} H2 heading(s); skills benefit from clear sections (When to use, Examples, Troubleshooting)",
            )
        )
    if code_blocks == 0:
        findings.append(
            Finding(
                file=rel,
                severity="warning",
                check="structure.examples",
                message="No fenced code blocks found; add concrete CLI/code examples",
            )
        )
    if inline_code == 0:
        findings.append(
            Finding(
                file=rel,
                severity="info",
                check="structure.examples",
                message="No inline code spans found; consider highlighting commands and fields",
            )
        )


def check_links(text: str, rel: str, findings: list):
    for match in re.finditer(r"\[([^\]]+)\]\(([^)]+)\)", text):
        href = match.group(2)
        if href.startswith(("http://", "https://", "#", "mailto:", "data:")):
            continue
        base_dir = (ROOT_DIR / rel).parent
        target = base_dir / href.split("#")[0]
        if not target.exists():
            findings.append(
                Finding(
                    file=rel,
                    line=line_number(text, match.start()),
                    severity="error",
                    check="links.validity",
                    message=f'Broken relative link: "{href}" -> {target.relative_to(ROOT_DIR)}',
                )
            )


def check_consistency(report: Report):
    plan_key = "skills/plan-authoring/SKILL.md"
    nano_key = "skills/nano-symphony/SKILL.md"

    plan_report = report.skills.get(plan_key)
    nano_report = report.skills.get(nano_key)

    if plan_report is None or nano_report is None:
        return

    plan_text = (ROOT_DIR / plan_key).read_text(encoding="utf-8")
    nano_text = (ROOT_DIR / nano_key).read_text(encoding="utf-8")

    if "dag(" in plan_text and "dag" not in nano_text:
        nano_report.findings.append(
            Finding(
                file=nano_key,
                severity="warning",
                check="consistency.plan-sdk",
                message="plan-authoring/SKILL.md documents dag() but nano-symphony/SKILL.md Plan script SDK table does not mention it",
            )
        )

    forbidden = ["Date", "Math.random", "require", "import", "process", "globalThis"]
    plan_has_all = all(g in plan_text for g in forbidden)
    nano_has_all = all(g in nano_text for g in forbidden)
    if plan_has_all and not nano_has_all:
        nano_report.findings.append(
            Finding(
                file=nano_key,
                severity="info",
                check="consistency.forbidden-globals",
                message="Consider aligning the forbidden globals list with plan-authoring/SKILL.md for consistency",
            )
        )


def score(findings: list[Finding]) -> int:
    base = 100
    penalties = sum(
        20 if f.severity == "error" else 8 if f.severity == "warning" else 2
        for f in findings
    )
    return max(0, base - penalties)


def to_plain_dict(obj):
    if isinstance(obj, list):
        return [to_plain_dict(item) for item in obj]
    if hasattr(obj, "__dataclass_fields__"):
        return {k: to_plain_dict(v) for k, v in asdict(obj).items()}
    return obj


def main():
    parser = argparse.ArgumentParser(description="Evaluate nano-symphony skills")
    parser.add_argument("--json", action="store_true", help="Emit JSON report")
    args = parser.parse_args()

    report = Report()

    for path in walk_skills():
        rel = str(path.relative_to(ROOT_DIR))
        text = path.read_text(encoding="utf-8")
        findings: list[Finding] = []

        fm = check_frontmatter(text, rel, findings)
        check_structure(text, rel, findings)
        check_links(text, rel, findings)

        report.skills[rel] = SkillReport(frontmatter=fm, findings=findings)
        report.summary.total += 1

    check_consistency(report)

    for skill_report in report.skills.values():
        skill_report.score = score(skill_report.findings)
        for finding in skill_report.findings:
            if finding.severity == "error":
                report.summary.errors += 1
            elif finding.severity == "warning":
                report.summary.warnings += 1
            else:
                report.summary.infos += 1

    if args.json:
        print(json.dumps(to_plain_dict(report), indent=2))
    else:
        for rel, data in report.skills.items():
            print(f"\n{rel} — score {data.score}/100")
            if data.frontmatter:
                print(f"  name: {data.frontmatter.get('name')}")
            for f in data.findings:
                line = f":{f.line}" if f.line else ""
                print(f"  [{f.severity.upper()}] {f.check}{line} — {f.message}")
            if not data.findings:
                print("  No findings — skill looks good.")
        print(
            f"\nSummary: {report.summary.total} skill(s), "
            f"{report.summary.errors} error(s), "
            f"{report.summary.warnings} warning(s), "
            f"{report.summary.infos} info(s)."
        )

    if report.summary.errors > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
