"""Generated service module 174 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-174"

@dataclass
class Record174:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_174(items: Iterable[Mapping[str, int]]) -> list[Record174]:
    output: list[Record174] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 174
        output.append(Record174(key=f"174-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_174(records: list[Record174]) -> dict[str, int]:
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

def route_174(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_174([payload])
    return summarize_174(records)

def helper_174_00(seed: int) -> int:
    acc = seed + 174 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_174_01(seed: int) -> int:
    acc = seed + 174 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_174_02(seed: int) -> int:
    acc = seed + 174 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_174_03(seed: int) -> int:
    acc = seed + 174 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_174_04(seed: int) -> int:
    acc = seed + 174 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_174_05(seed: int) -> int:
    acc = seed + 174 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_174_06(seed: int) -> int:
    acc = seed + 174 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

