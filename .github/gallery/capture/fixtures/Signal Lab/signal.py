"""A small signal-processing example for the Lumine gallery."""

from dataclasses import dataclass
from math import pi, sin
from statistics import mean

@dataclass(frozen=True)
class Sample:
    time: float
    amplitude: float

def sample_wave(frequency: float, duration: float, rate: int = 100):
    """Sample a sine wave at evenly spaced points in time."""
    return [
        Sample(time=index / rate, amplitude=sin(2 * pi * frequency * index / rate))
        for index in range(round(duration * rate))
    ]

def moving_average(samples: list[Sample], window: int = 5) -> list[Sample]:
    """Smooth a signal while preserving its time coordinates."""
    if window < 1:
        raise ValueError("The averaging window must be positive.")

    return [
        Sample(point.time, mean(item.amplitude for item in samples[max(0, index - window + 1):index + 1]))
        for index, point in enumerate(samples)
    ]

if __name__ == "__main__":
    signal = sample_wave(frequency=2, duration=1)
    smoothed = moving_average(signal, window=7)
    print(f"Processed {len(smoothed)} samples.")
