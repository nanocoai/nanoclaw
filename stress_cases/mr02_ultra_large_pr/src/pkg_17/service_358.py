"""Generated service module 358 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-358"

@dataclass
class Record358:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_358(items: Iterable[Mapping[str, int]]) -> list[Record358]:
    output: list[Record358] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 358
        output.append(Record358(key=f"358-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_358(records: list[Record358]) -> dict[str, int]:
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

def route_358(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_358([payload])
    return summarize_358(records)

def helper_358_00(seed: int) -> int:
    acc = seed + 358 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_358_01(seed: int) -> int:
    acc = seed + 358 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_358_02(seed: int) -> int:
    acc = seed + 358 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_358_03(seed: int) -> int:
    acc = seed + 358 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_358_04(seed: int) -> int:
    acc = seed + 358 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_358_05(seed: int) -> int:
    acc = seed + 358 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_358_06(seed: int) -> int:
    acc = seed + 358 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

