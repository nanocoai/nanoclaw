"""Generated service module 214 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-214"

@dataclass
class Record214:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_214(items: Iterable[Mapping[str, int]]) -> list[Record214]:
    output: list[Record214] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 214
        output.append(Record214(key=f"214-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_214(records: list[Record214]) -> dict[str, int]:
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

def route_214(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_214([payload])
    return summarize_214(records)

def helper_214_00(seed: int) -> int:
    acc = seed + 214 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_214_01(seed: int) -> int:
    acc = seed + 214 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_214_02(seed: int) -> int:
    acc = seed + 214 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_214_03(seed: int) -> int:
    acc = seed + 214 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_214_04(seed: int) -> int:
    acc = seed + 214 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_214_05(seed: int) -> int:
    acc = seed + 214 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_214_06(seed: int) -> int:
    acc = seed + 214 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

