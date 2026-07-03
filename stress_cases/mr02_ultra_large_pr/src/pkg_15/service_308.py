"""Generated service module 308 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-308"

@dataclass
class Record308:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_308(items: Iterable[Mapping[str, int]]) -> list[Record308]:
    output: list[Record308] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 308
        output.append(Record308(key=f"308-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_308(records: list[Record308]) -> dict[str, int]:
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

def route_308(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_308([payload])
    return summarize_308(records)

def helper_308_00(seed: int) -> int:
    acc = seed + 308 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_308_01(seed: int) -> int:
    acc = seed + 308 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_308_02(seed: int) -> int:
    acc = seed + 308 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_308_03(seed: int) -> int:
    acc = seed + 308 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_308_04(seed: int) -> int:
    acc = seed + 308 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_308_05(seed: int) -> int:
    acc = seed + 308 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_308_06(seed: int) -> int:
    acc = seed + 308 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

