"""Generated service module 396 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-396"

@dataclass
class Record396:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_396(items: Iterable[Mapping[str, int]]) -> list[Record396]:
    output: list[Record396] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 396
        output.append(Record396(key=f"396-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_396(records: list[Record396]) -> dict[str, int]:
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

def route_396(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_396([payload])
    return summarize_396(records)

def helper_396_00(seed: int) -> int:
    acc = seed + 396 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_396_01(seed: int) -> int:
    acc = seed + 396 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_396_02(seed: int) -> int:
    acc = seed + 396 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_396_03(seed: int) -> int:
    acc = seed + 396 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_396_04(seed: int) -> int:
    acc = seed + 396 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_396_05(seed: int) -> int:
    acc = seed + 396 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_396_06(seed: int) -> int:
    acc = seed + 396 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

