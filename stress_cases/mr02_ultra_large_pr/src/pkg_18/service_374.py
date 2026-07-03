"""Generated service module 374 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-374"

@dataclass
class Record374:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_374(items: Iterable[Mapping[str, int]]) -> list[Record374]:
    output: list[Record374] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 374
        output.append(Record374(key=f"374-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_374(records: list[Record374]) -> dict[str, int]:
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

def route_374(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_374([payload])
    return summarize_374(records)

def helper_374_00(seed: int) -> int:
    acc = seed + 374 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_374_01(seed: int) -> int:
    acc = seed + 374 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_374_02(seed: int) -> int:
    acc = seed + 374 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_374_03(seed: int) -> int:
    acc = seed + 374 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_374_04(seed: int) -> int:
    acc = seed + 374 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_374_05(seed: int) -> int:
    acc = seed + 374 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_374_06(seed: int) -> int:
    acc = seed + 374 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

