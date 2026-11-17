import ast
import io
import json
import re
import sys
import tokenize

request = json.load(sys.stdin)
source = request['source']
filename = request['filePath']
compile(source, filename, 'exec', dont_inherit=True)
tree = ast.parse(source, filename=filename)
tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
strings = [token for token in tokens if token.type == tokenize.STRING]
docstrings = []


def parameter_names(node):
    arguments = node.args
    parameters = arguments.posonlyargs + arguments.args + arguments.kwonlyargs
    if arguments.vararg:
        parameters.append(arguments.vararg)
    if arguments.kwarg:
        parameters.append(arguments.kwarg)
    return [parameter.arg for parameter in parameters]


def literal_content(raw):
    match = re.match(r'^[rRuUbB]*("""|\'\'\'|"|\')', raw)
    if not match or not raw.endswith(match.group(1)):
        return None
    return raw[match.end():len(raw) - len(match.group(1))]


def physical_lines(found, source_lines):
    rows = {}
    previous = None
    for token in found:
        content = literal_content(token.string)
        if content is None:
            return None
        for index, fragment in enumerate(re.split(r'\r\n|\r|\n', content)):
            row = token.start[0] + index
            if index == 0 and row in rows and previous is not None and previous.end[0] == row:
                gap = source_lines[row - 1][previous.end[1]:token.start[1]]
                if any(character.isspace() for character in gap):
                    fragment = ' ' + fragment
            rows[row] = rows.get(row, '') + fragment
        previous = token
    if not rows:
        return []
    return [rows.get(row, '') for row in range(min(rows), max(rows) + 1)]


def docstring_of(node, kind):
    if not kind:
        return None
    body = getattr(node, 'body', [])
    if not body:
        return None
    statement = body[0]
    if not isinstance(statement, ast.Expr):
        return None
    if not isinstance(statement.value, ast.Constant) or not isinstance(statement.value.value, str):
        return None
    literal = statement.value
    start = (literal.lineno, literal.col_offset)
    end = (literal.end_lineno, literal.end_col_offset)
    found = [token for token in strings if token.start >= start and token.end <= end]
    lines = physical_lines(found, source.splitlines()) if found else None
    if lines is None:
        return {'kind': kind, 'line': literal.lineno, 'invalid': True}
    return {
        'kind': kind,
        'line': found[0].start[0],
        'raws': [token.string for token in found],
        'lines': lines,
        'params': parameter_names(node) if kind == 'function' else [],
    }


def visit(node, kind):
    item = docstring_of(node, kind)
    if item:
        docstrings.append(item)
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            visit(child, 'function')
        elif isinstance(child, ast.ClassDef):
            visit(child, 'class')
        else:
            visit(child, None)


visit(tree, 'module')
comments = [
    {'line': token.start[0], 'value': token.string[1:]}
    for token in tokens
    if token.type == tokenize.COMMENT
]
json.dump({'docstrings': docstrings, 'comments': comments}, sys.stdout)
