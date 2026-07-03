"""Generated service module 338 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-338"

@dataclass
class Record338:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_338(items: Iterable[Mapping[str, int]]) -> list[Record338]:
    output: list[Record338] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 338
        output.append(Record338(key=f"338-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_338(records: list[Record338]) -> dict[str, int]:
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

def route_338(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_338([payload])
    return summarize_338(records)

def helper_338_00(seed: int) -> int:
    acc = seed + 338 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_338_01(seed: int) -> int:
    acc = seed + 338 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_338_02(seed: int) -> int:
    acc = seed + 338 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_338_03(seed: int) -> int:
    acc = seed + 338 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_338_04(seed: int) -> int:
    acc = seed + 338 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_338_05(seed: int) -> int:
    acc = seed + 338 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_338_06(seed: int) -> int:
    acc = seed + 338 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

