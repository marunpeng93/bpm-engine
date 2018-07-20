import mongoose from 'mongoose';

const { Schema } = mongoose;
const { Types } = Schema;

const ProcessInstanceSchema = new Schema(
  {
    processId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
    },
    workflowDefinition: {
      type: String,
      required: true,
    },
    payload: {
      type: Types.Mixed,
    },
  },
  { timestamps: true, minimize: false },
);

const TokenInstanceSchema = new Schema(
  {
    processId: {
      type: String,
      required: true,
      index: true,
    },
    tokenId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['running', 'paused', 'ended'],
    },
    currentActivity: {
      type: String,
    },
    payload: {
      type: Types.Mixed,
    },
    childs: {
      type: Array,
    },
    pending: {
      type: Array,
    },
    parent: {
      type: String,
    },
    isSubProcess: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true, minimize: false },
);

const WorkflowDefinitionSchema = new Schema(
  {
    workflowDefinitionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    xml: {
      type: String,
      required: true,
    },
  },
  { timestamps: true, minimize: false },
);

export default (client, names = {}) => ({
  tokenInstance: client.model(
    names.tokenInstance || 'bpmEngine_tokenInstance',
    TokenInstanceSchema,
  ),
  processInstance: client.model(
    names.processInstance || 'bpmEngine_processInstance',
    ProcessInstanceSchema,
  ),
  workflowDefinition: client.model(
    names.workflowDefinition || 'bpmEngine_workflowDefinition',
    WorkflowDefinitionSchema,
  ),
});
