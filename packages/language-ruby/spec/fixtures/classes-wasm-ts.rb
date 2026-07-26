require "a"
# ^ support.other.function

class Car < Vehicle
  # <- keyword.control.class
  #    ^ entity.name.type.class

  def init(id)
    # <- keyword.control.def
    # ^ entity.name.function

    @id = id
    # <- variable.other.readwrite.instance

    yield
    # <- keyword.control.yield
    return
    # <- keyword.control.return
    next
    # <- keyword.control.next
  end

  private
  # ^ keyword.other.special-method.private

  public
  # ^ keyword.other.special-method.public

  protected
  # ^ keyword.other.special-method.protected
end
# <- keyword.control.end
