import {Success, Failure, collect} from 'folktale/validation'
import Result from 'folktale/result'
import type {GraphqlizeOption} from './types'
import {path, I, ifElse, then, concat, compose, tap, K, validationToTask} from "./util";
import {List} from 'immutable-ext'
import {mergeSystemSchema} from './schema'
import {mergeOptionWithBuiltInScalars} from './builtin-scalars'


const required = name => ifElse(
	I,
	Success,
	()=>Failure([`${name} is required`])
)

const optionRequired = required('option')

const schemaTypesIsRequired = compose(
	required('schema.types'),
	path(['schema', 'types'])
)

const connectionOptionDialectIsRequired = compose(
	required('connection.option.dialect'),
	path(['connection', 'option', 'dialect'])
)

const coreOptionIsRequired = compose(
	required('core'),
	path(['core'])
)

const validators = [
	optionRequired,
	schemaTypesIsRequired,
	connectionOptionDialectIsRequired,
	coreOptionIsRequired
	//todo: only persistent type's field can set @relation directive
]

// GraphqlizeOption -> Task GraphqlizeOption
const validateOption = (option: GraphqlizeOption) =>
	validationToTask(
		List(validators)
		.ap(List.of(option))
		.reduce(concat, Success())
		.map(K(option))
	)
	
export const getOption = (option: GraphqlizeOption) =>
	validateOption(option)
		.map(mergeSystemSchema)
		.map(mergeOptionWithBuiltInScalars)