"""Small fail-closed expression evaluator for workflow routing."""
import ast
import math
import operator


class ConditionError(ValueError):
    pass


_COMPARISONS = {
    ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt,
    ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge,
    ast.In: lambda a, b: a in b, ast.NotIn: lambda a, b: a not in b,
    ast.Is: operator.is_, ast.IsNot: operator.is_not,
}


def _plain(value, depth=0):
    if depth > 8:
        raise ConditionError("condition value is too deeply nested")
    if value is None or type(value) in (bool, int, str):
        if isinstance(value, str) and len(value) > 100000:
            raise ConditionError("condition value is too large")
        return value
    if type(value) is float and math.isfinite(value):
        return value
    if type(value) in (list, tuple) and len(value) <= 1000:
        return type(value)(_plain(item, depth + 1) for item in value)
    if type(value) is dict and len(value) <= 1000 and all(type(key) is str for key in value):
        return {key: _plain(item, depth + 1) for key, item in value.items()}
    raise ConditionError("condition value is not bounded plain data")


def evaluate_condition(expression, state):
    if not isinstance(expression, str) or len(expression) > 2000 or not isinstance(state, dict):
        raise ConditionError("invalid condition input")
    try:
        tree = ast.parse(expression, mode="eval")
    except (SyntaxError, ValueError, RecursionError) as exc:
        raise ConditionError("invalid condition syntax") from exc
    if sum(1 for _ in ast.walk(tree)) > 100:
        raise ConditionError("condition is too complex")

    def visit(node):
        if isinstance(node, ast.Constant):
            return _plain(node.value)
        if isinstance(node, ast.Name) and node.id in ("iteration", "max_iterations"):
            return _plain(state.get(node.id))
        if isinstance(node, (ast.List, ast.Tuple)):
            values = [visit(item) for item in node.elts]
            return values if isinstance(node, ast.List) else tuple(values)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not visit(node.operand)
        if isinstance(node, ast.BoolOp) and isinstance(node.op, (ast.And, ast.Or)):
            values = (bool(visit(item)) for item in node.values)
            return all(values) if isinstance(node.op, ast.And) else any(values)
        if isinstance(node, ast.Compare):
            left = visit(node.left)
            for op, part in zip(node.ops, node.comparators):
                right = visit(part)
                if type(op) not in _COMPARISONS or not _COMPARISONS[type(op)](left, right):
                    return False
                left = right
            return True
        if isinstance(node, ast.Call) and not node.keywords:
            if (isinstance(node.func, ast.Attribute) and node.func.attr == "get"
                    and isinstance(node.func.value, ast.Name) and node.func.value.id == "state"
                    and 1 <= len(node.args) <= 2 and isinstance(node.args[0], ast.Constant)
                    and type(node.args[0].value) is str):
                default = visit(node.args[1]) if len(node.args) == 2 else None
                return _plain(state.get(node.args[0].value, default))
            if isinstance(node.func, ast.Name) and node.func.id == "len" and len(node.args) == 1:
                value = visit(node.args[0])
                if type(value) in (str, list, tuple, dict):
                    return len(value)
        raise ConditionError("unsupported condition expression")

    try:
        return bool(visit(tree.body))
    except ConditionError:
        raise
    except (TypeError, ValueError, OverflowError, RecursionError) as exc:
        raise ConditionError("condition evaluation failed") from exc
