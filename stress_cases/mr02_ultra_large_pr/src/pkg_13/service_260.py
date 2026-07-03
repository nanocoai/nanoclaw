"""Generated service module 260 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-260"

@dataclass
class Record260:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_260(items: Iterable[Mapping[str, int]]) -> list[Record260]:
    output: list[Record260] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 260
        output.append(Record260(key=f"260-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_260(records: list[Record260]) -> dict[str, int]:
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

def route_260(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_260([payload])
    return summarize_260(records)

def helper_260_00(seed: int) -> int:
    acc = seed + 260 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_260_01(seed: int) -> int:
    acc = seed + 260 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_260_02(seed: int) -> int:
    acc = seed + 260 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_260_03(seed: int) -> int:
    acc = seed + 260 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_260_04(seed: int) -> int:
    acc = seed + 260 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_260_05(seed: int) -> int:
    acc = seed + 260 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_260_06(seed: int) -> int:
    acc = seed + 260 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

