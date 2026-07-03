"""Generated service module 406 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-406"

@dataclass
class Record406:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_406(items: Iterable[Mapping[str, int]]) -> list[Record406]:
    output: list[Record406] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 406
        output.append(Record406(key=f"406-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_406(records: list[Record406]) -> dict[str, int]:
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

def route_406(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_406([payload])
    return summarize_406(records)

def helper_406_00(seed: int) -> int:
    acc = seed + 406 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_406_01(seed: int) -> int:
    acc = seed + 406 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_406_02(seed: int) -> int:
    acc = seed + 406 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_406_03(seed: int) -> int:
    acc = seed + 406 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_406_04(seed: int) -> int:
    acc = seed + 406 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_406_05(seed: int) -> int:
    acc = seed + 406 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_406_06(seed: int) -> int:
    acc = seed + 406 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

