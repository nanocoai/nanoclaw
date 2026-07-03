"""Generated service module 380 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-380"

@dataclass
class Record380:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_380(items: Iterable[Mapping[str, int]]) -> list[Record380]:
    output: list[Record380] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 380
        output.append(Record380(key=f"380-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_380(records: list[Record380]) -> dict[str, int]:
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

def route_380(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_380([payload])
    return summarize_380(records)

def helper_380_00(seed: int) -> int:
    acc = seed + 380 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_380_01(seed: int) -> int:
    acc = seed + 380 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_380_02(seed: int) -> int:
    acc = seed + 380 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_380_03(seed: int) -> int:
    acc = seed + 380 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_380_04(seed: int) -> int:
    acc = seed + 380 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_380_05(seed: int) -> int:
    acc = seed + 380 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_380_06(seed: int) -> int:
    acc = seed + 380 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

