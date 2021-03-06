import type {GraphqlizeOption, Schema, Model, Field, GenModelInputOption, Action} from './types'
import type {Fn1, Fn2, Fn3, CurriedFn2} from 'basic-types'
import {
  flatten, mergeWith, over, concat, lensProp, Box, prop, map, when, K, pipe, __, either, capitalize, join, tap,
  propEq, ifElse, filter, contains, propSatisfies, I, values, List, keys, deCapitalize, evolve
} from "./util"
// import {List} from 'immutable-ext'
import {FIELD_KIND, TYPE_KIND} from './constants'
import {applySpec, assoc, converge, isNil, mapObjIndexed} from "ramda";
import {joinGraphqlItems} from "./util/misc";
import {taskTry} from "./util/hkt";
import {propFn} from "./util/functions";

const systemSchema : Schema = {
	types: [
		`enum OrderDirectionEnum { Asc Desc }`,
		`type _QueryMeta @valueObject {count: Int!}`,
		`type File @valueObject {
			id: ID!
			name: String!
			createdAt: DateTime
			updatedAt: DateTime
			size: Int!
			url: String!
			key: String!
		}`
	]
}

export const mergeSystemSchema : Fn1<GraphqlizeOption, GraphqlizeOption> =
	over(lensProp('schema'), mergeWith(concat, systemSchema))

const getFieldInputType : Fn1< Action, Fn1<Field, string>>
= action => field => {
	const {fieldKind, graphqlType} = field
	if (fieldKind === FIELD_KIND.VALUE_OBJECT) return Box(graphqlType).map(capitalize).fold(concat(__, 'Input'))
	if (fieldKind === FIELD_KIND.RELATION) return Box(graphqlType)
		.map(capitalize)
		.map(concat(capitalize(action === 'create' ? 'create': 'upsert')))
		.fold(concat(__, 'Input'))
	return graphqlType
}

const buildInput : Fn3<Action, Model, [string], string>
= (action, model, fields) => `input ${capitalize(action)}${model.name}Input {${joinGraphqlItems(fields)}}`

const buildInputField: Fn2<GenModelInputOption, Field, Fn1<string, string>>
= ({allowIdNull, allowFieldsOtherThanIdNull, action}, field, mapName = (x=>x)) => fieldType => {
  const {name, isList, allowNullList, allowNull} = evolve({name: mapName}, field)
  return pipe(
    when(
      either(
        K(name !== 'id' && !allowNull),
        K(name === 'id' && !allowIdNull)
      ),
      concat(__, '!')
    ),
    when(K(isList), pipe(concat('['), concat(__, ']'))),
    when(K(isList && !allowNullList && !allowFieldsOtherThanIdNull), concat(__, '!')),
    concat(`${name}:`)
  )(fieldType)
}

const getInputField: Fn1<GenModelInputOption, Fn1<Field, string>>
= (genModelInputOption) => field => {
  const {action} = genModelInputOption
	return Box(field)
		.map(getFieldInputType(action))
		.fold(buildInputField(genModelInputOption, field))
}

const getInputFieldForRelation: Fn1<GenModelInputOption, Fn1<Field, string>>
= (genModelInputOption) => field => {
  const mapName = ifElse(
    prop('isList'),
    K(concat(__, 'Ids')),
    K(concat(__, 'Id'))
  )
  return field.fieldKind === FIELD_KIND.RELATION
    ? buildInputField(genModelInputOption, field, mapName(field))('ID')
    : null
}

const genModelInput : Fn2<GenModelInputOption, Model, string>
= option => model => Box(model)
	.map(prop('fields'))
	.map(map(
	  x => List.of(getInputField(option), getInputFieldForRelation(option))
    .ap(List.of(x))
    .filterNot(isNil)
    .toArray()
  ))
  .map(flatten)
	.fold(x => buildInput(option.action, model, x))

export const basicQueryOperators = {
	gte: I,
	gt: I,
	lt: I,
	lte: I,
	in: x => `[${x}]`,
	ne: I,
	between: x => `[${x}]`,
	notBetween: x => `[${x}]`,
	notIn: x => `[${x}]`,
	like: K('String'),
	notLike: K('String'),
}
const idQueryOperators = {
	in: x => `[${x}]`,
	ne: I,
	notIn: x => `[${x}]`,
}

export const oneToNQueryOperators = ['some', 'none']

const getModelFilterName : Fn1<string, string> = typeName => `${capitalize(typeName)}Filter`
const buildFilterByOperators: Fn1<{name: string, graphqlType: string, operators: {[id:string]: Fn1<string, string>}}, [string]>
= ({name, graphqlType, operators}) => Box(operators)
  .map(pipe(
    mapObjIndexed((getType, opName) => `${name}_${opName}:${getType(graphqlType)}`),
    values
  ))
  .fold(concat([`${name}:${graphqlType}`]))

const buildScalarAndEnumColumnFilter : Fn1<Field, [string]> = field => {
	const {name, graphqlType} = field
	return buildFilterByOperators({
    operators: graphqlType === 'ID' ? idQueryOperators : basicQueryOperators,
    name,
    graphqlType
	})
}
const buildValueObjectColumnFilter: Fn1<Field, [string]> = field => []
const buildRelationColumnFilter: Fn1<Field, [string]> = field => Box(field)
	.fold(ifElse(
		prop('isList'),
		K(oneToNQueryOperators.map(x => `${field.name}_${x}:${getModelFilterName(field.graphqlType)}`)),
		K([
			`${field.name}:${getModelFilterName(field.graphqlType)}`,
      ...buildFilterByOperators({operators: idQueryOperators, name: `${field.name}Id`, graphqlType: 'ID'})
		])
	)) //todo: implements 1-n every query

const genCreateModelInput = genModelInput({allowIdNull: true, allowFieldsOtherThanIdNull: false, action: 'create'})
const genUpdateModelInput = genModelInput({allowIdNull: false, allowFieldsOtherThanIdNull: true, action: 'update'})
const genUpsertModelInput = genModelInput({allowIdNull: true, allowFieldsOtherThanIdNull: true, action: 'upsert'})
const genDeleteModelInput : Fn1<Model, string> = model => buildInput('delete', model, ['id:ID!'])
const genModelFieldEnum : Fn1<Model, string> = model => Box(model)
	.map(prop('fields'))
	.map(filter(propSatisfies(contains(__, [FIELD_KIND.SCALAR, FIELD_KIND.ENUM]), 'fieldKind')))
	.map(map(prop('name')))
	.map(joinGraphqlItems)
	.fold(x => `enum ${capitalize(model.name)}FieldEnum {${x}}`)
const getModelFilter : Fn1<Model, string> = model => Box(model)
	.map(prop('fields'))
	.map(map(field => {
		switch (field.fieldKind) {
			case FIELD_KIND.RELATION: return buildRelationColumnFilter(field)
			case FIELD_KIND.SCALAR:
			case FIELD_KIND.ENUM: return buildScalarAndEnumColumnFilter(field)
			case FIELD_KIND.VALUE_OBJECT: return buildValueObjectColumnFilter(field)
			default: return []
		}
	}))
	.map(flatten)
	.map(concat([
		`AND:[${getModelFilterName(model.name)}]`,
		`OR:[${getModelFilterName(model.name)}]`
	]))
	.map(joinGraphqlItems)
	.fold(fields => `input ${getModelFilterName(model.name)} {${fields}}`)
const genModelOrderByInput : Fn1<Model, string> = model => {
	const name = capitalize(model.name)
	return `input ${name}OrderByInput { column: ${name}FieldEnum, direction: OrderDirectionEnum }`
}

const genValueObjectInput = genModelInput({allowIdNull: true, allowFieldsOtherThanIdNull: true, action: ''})

const genPersistenceModelInputs : Fn1<Model, [string]>
= model => List.of(
		genCreateModelInput, genDeleteModelInput, genUpdateModelInput, genUpsertModelInput,
		genModelFieldEnum, genModelOrderByInput, getModelFilter
	)
	.ap(List.of(model))
	.toArray()

const genValueObjectModelInputs : Fn1<Model, [string]>
= model => List.of(genValueObjectInput)
	.ap(List.of(model))
	.toArray()

export const isModelKind: CurriedFn2<string, Model, boolean> = propEq('modelKind')

export const genModelsInputs: Fn1<[Model], Schema>
= models => Box(models)
	.map(filter(either(isModelKind(TYPE_KIND.VALUE_OBJECT), isModelKind(TYPE_KIND.PERSISTENCE))))
	.map(map(ifElse(
		isModelKind(TYPE_KIND.PERSISTENCE),
		genPersistenceModelInputs,
		genValueObjectModelInputs
	)))
	.map(flatten)
	.fold(assoc('types', __, {}))

export const extendSystemFields: Fn1<[Model], Schema>
= models => Box(models)
  .map(filter(isModelKind(TYPE_KIND.PERSISTENCE)))
  .map(map(({name}) => `extend type ${name} {
    createdAt: DateTime
    updatedAt: DateTime
  }`))
  .fold(assoc('types', __, {}))

export const schemaToString: Fn1<Schema, string> = schema => taskTry(
	() => {
		const arrayToString = xs => Box(xs)
			.map(when(isNil, K([])))
			.fold(join('\n'))
		
		return List.of(
			propFn('types', arrayToString),
			pipe(
				propFn('queries', arrayToString),
				x => `type Query {\n${x}\n}`
			),
			pipe(
				propFn('mutations', arrayToString),
				x => `type Mutation {\n${x}\n}`
			),
			converge(
				(hasQueries, hasMutations) => (hasMutations || hasQueries)
						? `schema { ${hasQueries ? 'query:Query' : ''} ${hasMutations ? 'mutation:Mutation' : ''} }`
						: '',
				[prop('queries'), prop('mutations')]
			)
		)
		.ap(List.of(schema))
		.foldMap(concat('\n\n'), '')
	}
)

export const getScalarSchema: Fn1<GraphqlizeOption, Schema> = pipe(
	prop('customScalars'),
	when(isNil, K({})),
	keys,
	map(concat('scalar ')),
	assoc('types', __, {})
)