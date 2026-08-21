class quicksort:
  def sort(self, items):
    if len(items) <= 1: return items

    pivot = items.pop(0)
    left = []
    right = []

    # Comment in the middle

    while len(items) > 0:
      current = items.pop(0)
      if current < pivot:
        left.append(current)
      else:
        right.append(current)

    return self.sort(left) + [pivot] + self.sort(right)

  def noop(self):
    # just a noop

modules = quicksort
