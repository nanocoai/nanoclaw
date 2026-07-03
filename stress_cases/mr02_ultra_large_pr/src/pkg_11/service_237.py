"""Generated service module 237 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-237"

@dataclass
class Record237:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_237(items: Iterable[Mapping[str, int]]) -> list[Record237]:
    output: list[Record237] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 237
        output.append(Record237(key=f"237-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_237(records: list[Record237]) -> dict[str, int]:
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

def route_237(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_237([payload])
    return summarize_237(records)

def helper_237_00(seed: int) -> int:
    acc = seed + 237 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_237_01(seed: int) -> int:
    acc = seed + 237 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_237_02(seed: int) -> int:
    acc = seed + 237 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_237_03(seed: int) -> int:
    acc = seed + 237 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_237_04(seed: int) -> int:
    acc = seed + 237 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_237_05(seed: int) -> int:
    acc = seed + 237 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_237_06(seed: int) -> int:
    acc = seed + 237 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

