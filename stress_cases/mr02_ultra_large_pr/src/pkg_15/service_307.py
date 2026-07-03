"""Generated service module 307 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-307"

@dataclass
class Record307:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_307(items: Iterable[Mapping[str, int]]) -> list[Record307]:
    output: list[Record307] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 307
        output.append(Record307(key=f"307-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_307(records: list[Record307]) -> dict[str, int]:
    total = 0
    maximum = None
    minimum = None
    for record in records:
        total += record.value
        maximum = record.value if maximum is None else max(maximum, record.value)
        minimum = record.value if minimum is None else min(minimum, record.value)
    return {
        "count": len(records),
        "total": total,
        "maximum": maximum or 0,
        "minimum": minimum or 0,
    }

def route_307(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_307([payload])
    return summarize_307(records)

def helper_307_00(seed: int) -> int:
    acc = seed + 307 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_307_01(seed: int) -> int:
    acc = seed + 307 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_307_02(seed: int) -> int:
    acc = seed + 307 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_307_03(seed: int) -> int:
    acc = seed + 307 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_307_04(seed: int) -> int:
    acc = seed + 307 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_307_05(seed: int) -> int:
    acc = seed + 307 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_307_06(seed: int) -> int:
    acc = seed + 307 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

