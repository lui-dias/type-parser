import { TheComment, parseSync } from 'npm:@lui-dias/swc-napi'
import { ModuleItem } from 'npm:@swc/core'
import { Script, TsKeywordTypeKind, TsType, TsTypeElement } from 'npm:@swc/core'
import * as c from 'https://deno.land/std@0.216.0/fmt/colors.ts'

const parsed = parseSync(await Deno.readTextFile('test.ts'))

const program = JSON.parse(parsed.program) as Script
const comments = parsed.comments.filter(Boolean) as TheComment[]

await Deno.writeTextFile('program.json', JSON.stringify(program, null, 4))

const KW_TYPES = [
    'string',
    'number',
    'boolean',
    'null',
    'array',
    'union',
    'object',
    'intersection',
    'literal',
    'stringLiteral',
    'numberLiteral',
    'booleanLiteral',
    'reference',
    '__waiting-reference',
    'type',
] as const

type Schema = {
    name: string
    type: (typeof KW_TYPES)[number]
    children: Schema[]
    value?: unknown
    referenceName?: string
    range: [number, number]
    comment?: string
    parsedComments?: Record<string, string | number | boolean | string[]>
}

function parseKwType(type: TsKeywordTypeKind): (typeof KW_TYPES)[number] {
    switch (type) {
        case 'string':
            return 'string'
        case 'number':
            return 'number'
        case 'boolean':
            return 'boolean'
        case 'null':
            return 'null'
        default:
            throw new Error('Not supported')
    }
}

const programTypes = new Map<string, Schema>()

function parseType(name: string, t: TsType, range: [number, number]): Schema {
    if (t.type === 'TsKeywordType') {
        const kind = t.kind

        return {
            name,
            type: parseKwType(kind),
            children: [],
            range,
        }
    }
    if (t.type === 'TsArrayType') {
        const type = t.elemType.type

        if (type === 'TsKeywordType') {
            const kind = t.elemType.kind

            return {
                name,
                type: 'array',
                children: [
                    {
                        name: 'ofString',
                        type: parseKwType(kind),
                        children: [],
                        range: [t.elemType.span.start, t.elemType.span.end],
                    },
                ],
                range,
            }
        }
    }
    if (t.type === 'TsTypeLiteral') {
        const members = t.members.map(parseTypeMembers)

        return {
            name,
            type: 'object',
            children: members,
            range,
        }
    }
    if (t.type === 'TsUnionType') {
        const types = t.types

        return {
            name,
            type: 'union',
            children: types.map(i => parseType(name, i, range)),
            range,
        }
    }
    if (t.type === 'TsParenthesizedType') {
        return parseType(name, t.typeAnnotation, range)
    }
    if (t.type === 'TsLiteralType') {
        if (t.literal.type === 'BigIntLiteral' || t.literal.type === 'TemplateLiteral') throw new Error('Not supported')

        return {
            name,
            type:
                t.literal.type === 'StringLiteral'
                    ? 'stringLiteral'
                    : t.literal.type === 'NumericLiteral'
                      ? 'numberLiteral'
                      : 'booleanLiteral',
            children: [],
            value: t.literal.value,
            range: [t.span.start, t.span.end],
        }
    }
    if (t.type === 'TsTypeReference') {
        if (t.typeName.type !== 'Identifier') throw new Error('Not supported')

        const referenceName = t.typeName.value
        const schemaOfReference = programTypes.get(referenceName)

        if (!schemaOfReference) {
            return {
                name,
                type: '__waiting-reference',
                children: [],
                referenceName,
                range: [t.span.start, t.span.end],
            }
        }

        return {
            name,
            type: 'reference',
            children: [],
            value: schemaOfReference,
            range: [t.span.start, t.span.end],
        }
    }
    if (t.type === 'TsIntersectionType') {
        return {
            name,
            type: 'intersection',
            children: t.types.map(i => parseType(name, i, range)),
            range: [t.span.start, t.span.end],
        }
    }
    throw new Error(`Not supported ${t.type}`)
}

function parseTypeMembers(member: TsTypeElement): Schema {
    if (member.type !== 'TsPropertySignature') throw new Error('Not supported')
    if (member.key.type !== 'Identifier') throw new Error('Not supported')

    if (!member.typeAnnotation) throw new Error('Not supported')

    return parseType(member.key.value, member.typeAnnotation.typeAnnotation, [member.span.start, member.span.end])
}

for (let st of program.body as ModuleItem[]) {
    if (st.type === 'ExportDeclaration') {
        st = st.declaration
    }

    if (st.type === 'TsTypeAliasDeclaration') {
        const typeName = st.id.value

        const schemas = [] as Schema[]

        if (st.typeAnnotation.type === 'TsTypeLiteral') {
            for (const member of st.typeAnnotation.members) {
                const schema = parseTypeMembers(member)

                schemas.push(schema)
            }
        } else {
            schemas.push(parseType(st.id.value, st.typeAnnotation, [st.span.start, st.span.end]))
        }

        programTypes.set(typeName, {
            name: typeName,
            type: 'type',
            children: schemas,
            range: [st.span.start, st.span.end],
        })
    } else if (st.type === 'TsInterfaceDeclaration') {
        const typeName = st.id.value

        const schemas = [] as Schema[]

        for (const member of st.body.body) {
            const schema = parseTypeMembers(member)

            schemas.push(schema)
        }

        programTypes.set(typeName, {
            name: typeName,
            type: 'type',
            children: schemas,
            range: [st.span.start, st.span.end],
        })
    } else {
        throw new Error(`Not supported ${st.type}`)
    }
}

// Add references
for (const [, schemas] of programTypes) {
    for (const schema of schemas.children) {
        if (schema.type === '__waiting-reference') {
            const referenceName = schema.referenceName

            if (!referenceName) throw new Error('Unreachable')

            const schemaOfReference = programTypes.get(referenceName)

            if (!schemaOfReference) throw new Error('Reference Not found')

            schema.type = 'reference'
            schema.children = [schemaOfReference]
        }
    }
}

function flatSchemas(schemas: Schema[]) {
    const flat = [] as Schema[]

    for (const schema of schemas) {
        flat.push(schema)
        flat.push(...flatSchemas(schema.children))
    }

    return flat
}

const flattedSchemas = flatSchemas([...programTypes.values()])

// Add comments
for (const { text, spanLo, spanHi } of comments) {
    const flatted = flattedSchemas

    const mostNextClosestChild = flatted
        .filter(schema => schema.range[0] > spanHi)
        .sort((a, b) => a.range![0] - b.range![0])[0]

    if (!mostNextClosestChild) throw new Error('Unreachable')

    mostNextClosestChild.comment = text
}

function parseComment(comment: string): Record<string, unknown> {
    const parsed = {} as Record<string, unknown>

    for (const match of comment.matchAll(/@([\w-]+)(?=\s)(.+)?/gm)) {
        const [, key, value] = match
        if (value) {
            parsed[key] = value
        } else {
            parsed[key] = true
        }
    }

    return parsed
}

export const parseJSDocAttribute = (key: string, value: string) => {
    switch (key) {
        case 'examples':
            return value.split('\n').map(example => example.trim())
        case 'maximum':
        case 'exclusiveMaximum':
        case 'minimum':
        case 'exclusiveMinimum':
        case 'maxLength':
        case 'minLength':
        case 'multipleOf':
        case 'maxItems':
        case 'minItems':
        case 'maxProperties':
        case 'minProperties':
            return Number(value)
        case 'readOnly':
        case 'writeOnly':
        case 'ignore':
            return true
        case 'deprecated':
        case 'uniqueItems':
            return Boolean(value)
        case 'default':
            switch (value) {
                case 'true':
                    return true
                case 'false':
                    return false
                default:
                    return !Number.isNaN(+value) ? +value : value
            }
        default:
            return value
    }
}

// Add parsedComments
for (const schema of flattedSchemas) {
    if (schema.comment) {
        schema.parsedComments = Object.fromEntries(
            Object.entries(parseComment(schema.comment)).map(([key, value]) => {
                return [key, parseJSDocAttribute(key, String(value))]
            }),
        )
    }
}

function printSchema(schema: Schema, level = 0) {
    if (schema.parsedComments) {
        console.log(
            Object.entries(schema.parsedComments)
                .map(([key, value]) => `${' '.repeat(level * 4)}${c.blue(key)}: ${c.green(String(value))}`)
                .join('\n'),
        )
    }
    console.log(`${' '.repeat(level * 4)}${schema.name}: ${schema.type}`)

    if (schema.children.length) {
        for (const child of schema.children) {
            printSchema(child, level + 1)
        }
    }
}

for (const schema of programTypes.values()) {
    printSchema(schema)
    console.log()
}

await Deno.writeTextFile('result.json', JSON.stringify(Object.fromEntries(programTypes), null, 4))
