const log = require('../util/log');
const Cast = require('../util/cast');
const VariablePool = require('./variable-pool');
const jsexecute = require('./jsexecute');
// eslint-disable-next-line camelcase
const {run_sync} = require('scratch-vm-wasm-runtime');
const {InstructionType, ReturnReason} = require('scratch-vm-wasm-runtime/scratch_vm_wasm_runtime');

// Imported for JSDoc types, not to actually use
/* eslint-disable no-unused-vars */
const {IntermediateScript, IntermediateRepresentation} = require('./intermediate');
/* eslint-enable no-unused-vars */

/**
 * @fileoverview Convert intermediate representations to JavaScript functions.
 */

/* eslint-disable max-len */
/* eslint-disable prefer-template */

const sanitize = string => {
    if (typeof string !== 'string') {
        log.warn(`sanitize got unexpected type: ${typeof string}`);
        string = '' + string;
    }
    return JSON.stringify(string).slice(1, -1);
};

const TYPE_NUMBER = 1;
const TYPE_STRING = 2;
const TYPE_BOOLEAN = 3;
const TYPE_UNKNOWN = 4;
const TYPE_NUMBER_NAN = 5;

// Pen-related constants
const PEN_EXT = 'runtime.ext_pen';
const PEN_STATE = `${PEN_EXT}._getPenState(target)`;

/**
 * @typedef Input
 * @property {() => string} asNumber
 * @property {() => string} asNumberOrNaN
 * @property {() => string} asString
 * @property {() => string} asBoolean
 * @property {() => string} asColor
 * @property {() => string} asUnknown
 * @property {() => string} asSafe
 * @property {() => boolean} isAlwaysNumber
 * @property {() => boolean} isAlwaysNumberOrNaN
 * @property {() => boolean} isNeverNumber
 */

/**
 * @implements {Input}
 */
class TypedInput {
    constructor (source, type) {
        // for debugging
        if (typeof type !== 'number') throw new Error('type is invalid');
        this.source = source;
        this.type = type;
    }

    asNumber () {
        if (this.type === TYPE_NUMBER) return this.source;
        if (this.type === TYPE_NUMBER_NAN) return `(${this.source} || 0)`;
        return `(+${this.source} || 0)`;
    }

    asNumberOrNaN () {
        if (this.type === TYPE_NUMBER || this.type === TYPE_NUMBER_NAN) return this.source;
        return `(+${this.source})`;
    }

    asString () {
        if (this.type === TYPE_STRING) return this.source;
        return `("" + ${this.source})`;
    }

    asBoolean () {
        if (this.type === TYPE_BOOLEAN) return this.source;
        return `toBoolean(${this.source})`;
    }

    asColor () {
        return this.asUnknown();
    }

    asUnknown () {
        return this.source;
    }

    asSafe () {
        return this.asUnknown();
    }

    isAlwaysNumber () {
        return this.type === TYPE_NUMBER;
    }

    isAlwaysNumberOrNaN () {
        return this.type === TYPE_NUMBER || this.type === TYPE_NUMBER_NAN;
    }

    isNeverNumber () {
        return false;
    }
}

/**
 * @implements {Input}
 */
class ConstantInput {
    constructor (constantValue, safe) {
        this.constantValue = constantValue;
        this.safe = safe;
    }

    asNumber () {
        // Compute at compilation time
        const numberValue = +this.constantValue;
        if (numberValue) {
            // It's important that we use the number's stringified value and not the constant value
            // Using the constant value allows numbers such as "010" to be interpreted as 8 (or SyntaxError in strict mode) instead of 10.
            return numberValue.toString();
        }
        // numberValue is one of 0, -0, or NaN
        if (Object.is(numberValue, -0)) {
            return '-0';
        }
        return '0';
    }

    asNumberOrNaN () {
        return this.asNumber();
    }

    asString () {
        return `"${sanitize('' + this.constantValue)}"`;
    }

    asBoolean () {
        // Compute at compilation time
        return Cast.toBoolean(this.constantValue).toString();
    }

    asColor () {
        // Attempt to parse hex code at compilation time
        if (/^#[0-9a-f]{6,8}$/i.test(this.constantValue)) {
            const hex = this.constantValue.substr(1);
            return Number.parseInt(hex, 16).toString();
        }
        return this.asUnknown();
    }

    asUnknown () {
        // Attempt to convert strings to numbers if it is unlikely to break things
        if (typeof this.constantValue === 'number') {
            // todo: handle NaN?
            return this.constantValue;
        }
        const numberValue = +this.constantValue;
        if (numberValue.toString() === this.constantValue) {
            return this.constantValue;
        }
        return this.asString();
    }

    asSafe () {
        if (this.safe) {
            return this.asUnknown();
        }
        return this.asString();
    }

    isAlwaysNumber () {
        const value = +this.constantValue;
        if (Number.isNaN(value)) {
            return false;
        }
        // Empty strings evaluate to 0 but should not be considered a number.
        if (value === 0) {
            return this.constantValue.toString().trim() !== '';
        }
        return true;
    }

    isAlwaysNumberOrNaN () {
        return this.isAlwaysNumber();
    }

    isNeverNumber () {
        return Number.isNaN(+this.constantValue);
    }
}

const getNamesOfCostumesAndSounds = runtime => {
    const result = new Set();
    for (const target of runtime.targets) {
        if (target.isOriginal) {
            const sprite = target.sprite;
            for (const costume of sprite.costumes) {
                result.add(costume.name);
            }
            for (const sound of sprite.sounds) {
                result.add(sound.name);
            }
        }
    }
    return result;
};

/**
 * A frame contains some information about the current substack being compiled.
 */
class Frame {
    constructor (isLoop) {
        /**
         * Whether the current stack runs in a loop (while, for)
         * @type {boolean}
         * @readonly
         */
        this.isLoop = isLoop;

        /**
         * Whether the current block is the last block in the stack.
         * @type {boolean}
         */
        this.isLastBlock = false;
    }
}

class BytecodeInstruction {
    /**
     * Creates an instruction to add the bytecode.
     *
     * @param {InstructionType} type The type of the instruction
     * @param {number} argument The argument for the instruction, internally a
     * u32 but represented as a `number`
     */
    constructor (type, argument) {
        /**
         * The instruction type
         * @type {InstructionType}
         */
        this.type = type;
        /**
         * The argument
         * @type {number}
         */
        this.arg = argument || 0;
    }

    /**
     * Writes the bytecode for the instruction a buffer.
     *
     * @param {ArrayBuffer} buffer The buffer to write to
     * @param {number} offset The offset of the buffer
     */
    writeToBuffer (buffer, offset) {
        const instruction = new DataView(buffer, offset + 0, 2);
        // 2 bytes of padding in between
        const argument = new DataView(buffer, offset + 4, 4);
        instruction.setUint16(0, this.type, true);
        argument.setUint32(0, this.arg, true);
    }
}

class JSGenerator {
    /**
     * @param {IntermediateScript} script
     * @param {IntermediateRepresentation} ir
     * @param {Target} target
     */
    constructor (script, ir, target) {
        this.script = script;
        this.ir = ir;
        this.target = target;
        this.source = '';
        /** @type {Array.<BytecodeInstruction>} */
        this.bytecodeSourceList = [];

        /**
         * @type {Object.<string, VariableInput>}
         */
        this.variableInputs = {};

        /**
         * An array of constant values.
         * @type {Array.<string | number | boolean>}
         */
        this.constants = [];

        /**
         * An array of list IDs
         * @type {Array.<string>}
         */
        this.lists = [];

        /**
         * An array of variable IDs
         * @type {Array.<string>}
         */
        this.variables = [];

        this.isWarp = script.isWarp;
        this.isProcedure = script.isProcedure;
        this.warpTimer = script.warpTimer;

        /**
         * Stack of frames, most recent is last item.
         * @type {Frame[]}
         */
        this.frames = [];

        /**
         * The current Frame.
         * @type {Frame}
         */
        this.currentFrame = null;

        this.namesOfCostumesAndSounds = getNamesOfCostumesAndSounds(target.runtime);

        this.localVariables = new VariablePool('a');
        this._setupVariablesPool = new VariablePool('b');
        this._setupVariables = {};

        this.descendedIntoModulo = false;
        this.isInHat = false;

        this.debug = this.target.runtime.debug;
    }

    /**
     * Enter a new frame
     * @param {Frame} frame New frame.
     */
    pushFrame (frame) {
        this.frames.push(frame);
        this.currentFrame = frame;
    }

    /**
     * Exit the current frame
     */
    popFrame () {
        this.frames.pop();
        this.currentFrame = this.frames[this.frames.length - 1];
    }

    /**
     * @returns {boolean} true if the current block is the last command of a loop
     */
    isLastBlockInLoop () {
        for (let i = this.frames.length - 1; i >= 0; i--) {
            const frame = this.frames[i];
            if (!frame.isLastBlock) {
                return false;
            }
            if (frame.isLoop) {
                return true;
            }
        }
        return false;
    }

    /**
     * @param {any[]} stack The stack to compile.
     * @returns {BytecodeInstruction[]} The instructions compiled.
     */
    descendStack (stack) {
        const output = [];
        for (const node of stack) {
            output.push(...this.descendStackedBlock(node));
        }
        return output;
    }

    /**
     * Gets the key for the next constant
     * @param {string | number | boolean} value The constant value
     * @returns {number} The key in the constants array of the value
     */
    referenceConstant (value) {
        const cached = this.constants.indexOf(value);
        if (cached > -1) return cached;
        return this.constants.push(value) - 1;
    }

    /**
     * Gets the key for the next list
     * @param {*} list The list to reference
     * @returns {number} The key in the list array of the value
     */
    referenceList (list) {
        const cached = this.lists.indexOf(list.id);
        if (cached > -1) return cached;
        return this.lists.push(list.id) - 1;
    }

    /**
     * Gets the key for the next variable
     * @param {*} variable The variable to reference
     * @returns {number} The key in the list array of the value
     */
    referenceWasmVariable (variable) {
        const cached = this.lists.indexOf(variable.id);
        if (cached > -1) return cached;
        return this.lists.push(variable.id) - 1;
    }

    /**
     * @param {object} node Input node to compile.
     * @returns {BytecodeInstruction[]} The exact instructions to run to load
     * the output of the node onto the top of the stack.
     */
    descendInput (node) {
        log.debug(node);
        switch (node.kind) {
        case 'addons.call': {
            log.warn('WASM: Compiler does not support addons');
            throw new Error('failed to compile (see above)');
        }

        case 'args.boolean':
            // needs explanation
            return new TypedInput(`toBoolean(p${node.index})`, TYPE_BOOLEAN);
        case 'args.stringNumber':
            // needs explanation
            return new TypedInput(`p${node.index}`, TYPE_UNKNOWN);

        case 'compat': {
            log.warn('WASM: Compiler does not support compat blocks');
            throw new Error('failed to compile (see above)');
        }

        case 'constant':
            return [
                new BytecodeInstruction(InstructionType.LoadConst, this.referenceConstant(node.value))
            ];

        case 'keyboard.pressed':
            // relies on runtime
            return new TypedInput(`runtime.ioDevices.keyboard.getKeyIsDown(${this.descendInput(node.key).asSafe()})`, TYPE_BOOLEAN);

        case 'list.contains':
            return [
                ...this.descendInput(node.item),
                new BytecodeInstruction(InstructionType.ListIIncludes, this.referenceList(node.list))
            ];
            
        case 'list.contents':
            // TODO needs implementation in scratch-vm-wasm-runtime
            log.warn('WASM: No compiler implementation for `list.contents`');
            throw new Error('failed to compile (see above)');
        case 'list.get':
            return [
                ...this.descendInput(node.index),
                new BytecodeInstruction(InstructionType.ListLoad, this.referenceList(node.list))
            ];
        case 'list.indexOf':
            return [
                ...this.descendInput(node.item),
                new BytecodeInstruction(InstructionType.ListIFind, this.referenceList(node.list))
            ];
        case 'list.length':
            return [
                new BytecodeInstruction(InstructionType.ListLen, this.referenceList(node.list))
            ];

        case 'looks.size':
        case 'looks.backdropName':
        case 'looks.backdropNumber':
        case 'looks.costumeName':
        case 'looks.costumeNumber':
            // TODO needs implementation in scratch-vm-wasm-runtime
            log.warn(`WASM: No compiler implementation for \`${node.kind}\``);
            throw new Error('failed to compile (see above)');

        case 'motion.direction':
        case 'motion.x':
        case 'motion.y':
            // TODO needs implementation in scratch-vm-wasm-runtime
            log.warn(`WASM: No compiler implementation for \`${node.kind}\``);
            throw new Error('failed to compile (see above)');

        case 'mouse.down':
        case 'mouse.x':
        case 'mouse.y':
            // TODO needs implementation in scratch-vm-wasm-runtime
            log.warn(`WASM: No compiler implementation for \`${node.kind}\``);
            throw new Error('failed to compile (see above)');

        case 'noop':
            // This could also add a no-op instruction to the bytecode
            return [];

        case 'op.abs':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnaryAbs)
            ];
        case 'op.acos':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnaryAcos)
            ];
        case 'op.add':
            return [
                ...this.descendInput(node.left),
                ...this.descendInput(node.right),
                new BytecodeInstruction(InstructionType.OpAdd)
            ];
        case 'op.and':
            return [
                ...this.descendInput(node.left),
                ...this.descendInput(node.right),
                new BytecodeInstruction(InstructionType.OpAnd)
            ];
        case 'op.asin':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnaryAsin)
            ];
        case 'op.atan':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnaryAtan)
            ];
        case 'op.ceiling':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnaryCeil)
            ];
        case 'op.contains':
            // TODO needs implementation in scratch-vm-wasm-runtime
            log.warn(`WASM: No compiler implementation for \`${node.kind}\``);
            throw new Error('failed to compile (see above)');
        case 'op.cos':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnaryCos)
            ];
        case 'op.divide':
            return [
                ...this.descendInput(node.left),
                ...this.descendInput(node.right),
                new BytecodeInstruction(InstructionType.OpDivide)
            ];
        case 'op.equals':
            return [
                ...this.descendInput(node.left),
                ...this.descendInput(node.right),
                new BytecodeInstruction(InstructionType.OpEq)
            ];
        case 'op.e^':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnaryEPow)
            ];
        case 'op.floor':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnaryFloor)
            ];
        case 'op.greater':
            return [
                ...this.descendInput(node.right),
                ...this.descendInput(node.left),
                new BytecodeInstruction(InstructionType.OpLt)
            ];
        case 'op.join':
            // TODO needs implementation in scratch-vm-wasm-runtime
            log.warn(`WASM: No compiler implementation for \`${node.kind}\``);
            throw new Error('failed to compile (see above)');
        case 'op.length':
            // TODO needs implementation in scratch-vm-wasm-runtime
            log.warn(`WASM: No compiler implementation for \`${node.kind}\``);
            throw new Error('failed to compile (see above)');
        case 'op.less':
            return [
                ...this.descendInput(node.left),
                ...this.descendInput(node.right),
                new BytecodeInstruction(InstructionType.OpLt)
            ];
        case 'op.letterOf':
            // TODO needs implementation in scratch-vm-wasm-runtime
            log.warn(`WASM: No compiler implementation for \`${node.kind}\``);
            throw new Error('failed to compile (see above)');
        case 'op.ln':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnaryLn)
            ];
        case 'op.log':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnaryLog)
            ];
        case 'op.mod':
            // TODO needs implementation in scratch-vm-wasm-runtime
            log.warn(`WASM: No compiler implementation for \`${node.kind}\``);
            throw new Error('failed to compile (see above)');
        case 'op.multiply':
            return [
                ...this.descendInput(node.left),
                ...this.descendInput(node.right),
                new BytecodeInstruction(InstructionType.OpMultiply)
            ];
        case 'op.not':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnaryNot)
            ];
        case 'op.or':
            return [
                ...this.descendInput(node.left),
                ...this.descendInput(node.right),
                new BytecodeInstruction(InstructionType.OpOr)
            ];
        case 'op.random':
        case 'op.round':
            // TODO needs implementation in scratch-vm-wasm-runtime
            log.warn(`WASM: No compiler implementation for \`${node.kind}\``);
            throw new Error('failed to compile (see above)');
        case 'op.sin':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnarySin)
            ];
        case 'op.sqrt':
            return [
                ...this.descendInput(node.value),
                new BytecodeInstruction(InstructionType.UnarySqrt)
            ];
        case 'op.subtract':
            // Needs to be marked as NaN because Infinity - Infinity === NaN
            return new TypedInput(`(${this.descendInput(node.left).asNumber()} - ${this.descendInput(node.right).asNumber()})`, TYPE_NUMBER_NAN);
        case 'op.tan':
            return new TypedInput(`tan(${this.descendInput(node.value).asNumber()})`, TYPE_NUMBER_NAN);
        case 'op.10^':
            return new TypedInput(`(10 ** ${this.descendInput(node.value).asNumber()})`, TYPE_NUMBER);

        case 'procedures.call': {
            const procedureCode = node.code;
            const procedureVariant = node.variant;
            const procedureData = this.ir.procedures[procedureVariant];
            if (procedureData.stack === null) {
                // TODO still need to evaluate arguments for side effects
                return new TypedInput('""', TYPE_STRING);
            }

            // Recursion makes this complicated because:
            //  - We need to yield *between* each call in the same command block
            //  - We need to evaluate arguments *before* that yield happens

            const procedureReference = `thread.procedures["${sanitize(procedureVariant)}"]`;
            const args = [];
            for (const input of node.arguments) {
                args.push(this.descendInput(input).asSafe());
            }
            const joinedArgs = args.join(',');

            const yieldForRecursion = !this.isWarp && procedureCode === this.script.procedureCode;
            const yieldForHat = this.isInHat;
            if (yieldForRecursion || yieldForHat) {
                const runtimeFunction = procedureData.yields ? 'yieldThenCallGenerator' : 'yieldThenCall';
                return new TypedInput(`(yield* ${runtimeFunction}(${procedureReference}, ${joinedArgs}))`, TYPE_UNKNOWN);
            }
            if (procedureData.yields) {
                return new TypedInput(`(yield* ${procedureReference}(${joinedArgs}))`, TYPE_UNKNOWN);
            }
            return new TypedInput(`${procedureReference}(${joinedArgs})`, TYPE_UNKNOWN);
        }

        case 'sensing.answer':
            return new TypedInput(`runtime.ext_scratch3_sensing._answer`, TYPE_STRING);
        case 'sensing.colorTouchingColor':
            return new TypedInput(`target.colorIsTouchingColor(colorToList(${this.descendInput(node.target).asColor()}), colorToList(${this.descendInput(node.mask).asColor()}))`, TYPE_BOOLEAN);
        case 'sensing.date':
            return new TypedInput(`(new Date().getDate())`, TYPE_NUMBER);
        case 'sensing.dayofweek':
            return new TypedInput(`(new Date().getDay() + 1)`, TYPE_NUMBER);
        case 'sensing.daysSince2000':
            return new TypedInput('daysSince2000()', TYPE_NUMBER);
        case 'sensing.distance':
            // TODO: on stages, this can be computed at compile time
            return new TypedInput(`distance(${this.descendInput(node.target).asString()})`, TYPE_NUMBER);
        case 'sensing.hour':
            return new TypedInput(`(new Date().getHours())`, TYPE_NUMBER);
        case 'sensing.minute':
            return new TypedInput(`(new Date().getMinutes())`, TYPE_NUMBER);
        case 'sensing.month':
            return new TypedInput(`(new Date().getMonth() + 1)`, TYPE_NUMBER);
        case 'sensing.of': {
            const object = this.descendInput(node.object).asString();
            const property = node.property;
            if (node.object.kind === 'constant') {
                const isStage = node.object.value === '_stage_';
                // Note that if target isn't a stage, we can't assume it exists
                const objectReference = isStage ? 'stage' : this.evaluateOnce(`runtime.getSpriteTargetByName(${object})`);
                if (property === 'volume') {
                    return new TypedInput(`(${objectReference} ? ${objectReference}.volume : 0)`, TYPE_NUMBER);
                }
                if (isStage) {
                    switch (property) {
                    case 'background #':
                        // fallthrough for scratch 1.0 compatibility
                    case 'backdrop #':
                        return new TypedInput(`(${objectReference}.currentCostume + 1)`, TYPE_NUMBER);
                    case 'backdrop name':
                        return new TypedInput(`${objectReference}.getCostumes()[${objectReference}.currentCostume].name`, TYPE_STRING);
                    }
                } else {
                    switch (property) {
                    case 'x position':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.x : 0)`, TYPE_NUMBER);
                    case 'y position':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.y : 0)`, TYPE_NUMBER);
                    case 'direction':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.direction : 0)`, TYPE_NUMBER);
                    case 'costume #':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.currentCostume + 1 : 0)`, TYPE_NUMBER);
                    case 'costume name':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.getCostumes()[${objectReference}.currentCostume].name : 0)`, TYPE_UNKNOWN);
                    case 'size':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.size : 0)`, TYPE_NUMBER);
                    }
                }
                const variableReference = this.evaluateOnce(`${objectReference} && ${objectReference}.lookupVariableByNameAndType("${sanitize(property)}", "", true)`);
                return new TypedInput(`(${variableReference} ? ${variableReference}.value : 0)`, TYPE_UNKNOWN);
            }
            return new TypedInput(`runtime.ext_scratch3_sensing.getAttributeOf({OBJECT: ${object}, PROPERTY: "${sanitize(property)}" })`, TYPE_UNKNOWN);
        }
        case 'sensing.second':
            return new TypedInput(`(new Date().getSeconds())`, TYPE_NUMBER);
        case 'sensing.touching':
            return new TypedInput(`target.isTouchingObject(${this.descendInput(node.object).asUnknown()})`, TYPE_BOOLEAN);
        case 'sensing.touchingColor':
            return new TypedInput(`target.isTouchingColor(colorToList(${this.descendInput(node.color).asColor()}))`, TYPE_BOOLEAN);
        case 'sensing.username':
            return new TypedInput('runtime.ioDevices.userData.getUsername()', TYPE_STRING);
        case 'sensing.year':
            return new TypedInput(`(new Date().getFullYear())`, TYPE_NUMBER);

        case 'timer.get':
            return new TypedInput('runtime.ioDevices.clock.projectTimer()', TYPE_NUMBER);

        case 'tw.lastKeyPressed':
            return new TypedInput('runtime.ioDevices.keyboard.getLastKeyPressed()', TYPE_STRING);

        case 'var.get':
            return this.descendVariable(node.variable);

        default:
            log.warn(`JS: Unknown input: ${node.kind}`, node);
            throw new Error(`JS: Unknown input: ${node.kind}`);
        }
    }

    /**
     * @param {*} node Stacked node to compile.
     * @returns {BytecodeInstruction[]} Pops the stack
     */
    descendStackedBlock (node) {
        switch (node.kind) {
        case 'addons.call': {
            log.warn('WASM: Compiler does not support addons');
            throw new Error('failed to compile (see above)');
        }

        case 'compat': {
            log.warn('WASM: Compiler does not support compat blocks');
            throw new Error('failed to compile (see above)');
        }

        case 'control.createClone':
            this.source += `runtime.ext_scratch3_control._createClone(${this.descendInput(node.target).asString()}, target);\n`;
            break;
        case 'control.deleteClone':
            this.source += 'if (!target.isOriginal) {\n';
            this.source += '  runtime.disposeTarget(target);\n';
            this.source += '  runtime.stopForTarget(target);\n';
            this.retire();
            this.source += '}\n';
            break;
        case 'control.for': {
            this.resetVariableInputs();
            const index = this.localVariables.next();
            this.source += `var ${index} = 0; `;
            this.source += `while (${index} < ${this.descendInput(node.count).asNumber()}) { `;
            this.source += `${index}++; `;
            this.source += `${this.referenceVariable(node.variable)}.value = ${index};\n`;
            this.descendStack(node.do, new Frame(true));
            this.yieldLoop();
            this.source += '}\n';
            break;
        }
        case 'control.if':
            this.source += `if (${this.descendInput(node.condition).asBoolean()}) {\n`;
            this.descendStack(node.whenTrue, new Frame(false));
            // only add the else branch if it won't be empty
            // this makes scripts have a bit less useless noise in them
            if (node.whenFalse.length) {
                this.source += `} else {\n`;
                this.descendStack(node.whenFalse, new Frame(false));
            }
            this.source += `}\n`;
            break;
        case 'control.repeat': {
            const i = this.localVariables.next();
            this.source += `for (var ${i} = ${this.descendInput(node.times).asNumber()}; ${i} >= 0.5; ${i}--) {\n`;
            this.descendStack(node.do, new Frame(true));
            this.yieldLoop();
            this.source += `}\n`;
            break;
        }
        case 'control.stopAll':
            this.source += 'runtime.stopAll();\n';
            this.retire();
            break;
        case 'control.stopOthers':
            this.source += 'runtime.stopForTarget(target, thread);\n';
            break;
        case 'control.stopScript':
            this.stopScript();
            break;
        case 'control.wait': {
            const duration = this.localVariables.next();
            this.source += `thread.timer = timer();\n`;
            this.source += `var ${duration} = Math.max(0, 1000 * ${this.descendInput(node.seconds).asNumber()});\n`;
            this.requestRedraw();
            // always yield at least once, even on 0 second durations
            this.yieldNotWarp();
            this.source += `while (thread.timer.timeElapsed() < ${duration}) {\n`;
            this.yieldStuckOrNotWarp();
            this.source += '}\n';
            this.source += 'thread.timer = null;\n';
            break;
        }
        case 'control.waitUntil': {
            this.resetVariableInputs();
            this.source += `while (!${this.descendInput(node.condition).asBoolean()}) {\n`;
            this.yieldStuckOrNotWarp();
            this.source += `}\n`;
            break;
        }
        case 'control.while':
            this.resetVariableInputs();
            this.source += `while (${this.descendInput(node.condition).asBoolean()}) {\n`;
            this.descendStack(node.do, new Frame(true));
            if (node.warpTimer) {
                this.yieldStuckOrNotWarp();
            } else {
                this.yieldLoop();
            }
            this.source += `}\n`;
            break;

        case 'hat.edge':
            this.isInHat = true;
            this.source += '{\n';
            // For exact Scratch parity, evaluate the input before checking old edge state.
            // Can matter if the input is not instantly evaluated.
            this.source += `const resolvedValue = ${this.descendInput(node.condition).asBoolean()};\n`;
            this.source += `const id = "${sanitize(node.id)}";\n`;
            this.source += 'const hasOldEdgeValue = target.hasEdgeActivatedValue(id);\n';
            this.source += `const oldEdgeValue = target.updateEdgeActivatedValue(id, resolvedValue);\n`;
            this.source += `const edgeWasActivated = hasOldEdgeValue ? (!oldEdgeValue && resolvedValue) : resolvedValue;\n`;
            this.source += `if (!edgeWasActivated) {\n`;
            this.retire();
            this.source += '}\n';
            this.source += 'yield;\n';
            this.source += '}\n';
            this.isInHat = false;
            break;
        case 'hat.predicate':
            this.isInHat = true;
            this.source += `if (!${this.descendInput(node.condition).asBoolean()}) {\n`;
            this.retire();
            this.source += '}\n';
            this.source += 'yield;\n';
            this.isInHat = false;
            break;

        case 'event.broadcast':
            this.source += `startHats("event_whenbroadcastreceived", { BROADCAST_OPTION: ${this.descendInput(node.broadcast).asString()} });\n`;
            this.resetVariableInputs();
            break;
        case 'event.broadcastAndWait':
            this.source += `yield* waitThreads(startHats("event_whenbroadcastreceived", { BROADCAST_OPTION: ${this.descendInput(node.broadcast).asString()} }));\n`;
            this.yielded();
            break;

        case 'list.add': {
            const list = this.referenceVariable(node.list);
            this.source += `${list}.value.push(${this.descendInput(node.item).asSafe()});\n`;
            this.source += `${list}._monitorUpToDate = false;\n`;
            break;
        }
        case 'list.delete': {
            const list = this.referenceVariable(node.list);
            const index = this.descendInput(node.index);
            if (index instanceof ConstantInput) {
                if (index.constantValue === 'last') {
                    this.source += `${list}.value.pop();\n`;
                    this.source += `${list}._monitorUpToDate = false;\n`;
                    break;
                }
                if (+index.constantValue === 1) {
                    this.source += `${list}.value.shift();\n`;
                    this.source += `${list}._monitorUpToDate = false;\n`;
                    break;
                }
                // do not need a special case for all as that is handled in IR generation (list.deleteAll)
            }
            this.source += `listDelete(${list}, ${index.asUnknown()});\n`;
            break;
        }
        case 'list.deleteAll':
            this.source += `${this.referenceVariable(node.list)}.value = [];\n`;
            break;
        case 'list.hide':
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.list.id)}", element: "checkbox", value: false }, runtime);\n`;
            break;
        case 'list.insert': {
            const list = this.referenceVariable(node.list);
            const index = this.descendInput(node.index);
            const item = this.descendInput(node.item);
            if (index instanceof ConstantInput && +index.constantValue === 1) {
                this.source += `${list}.value.unshift(${item.asSafe()});\n`;
                this.source += `${list}._monitorUpToDate = false;\n`;
                break;
            }
            this.source += `listInsert(${list}, ${index.asUnknown()}, ${item.asSafe()});\n`;
            break;
        }
        case 'list.replace':
            this.source += `listReplace(${this.referenceVariable(node.list)}, ${this.descendInput(node.index).asUnknown()}, ${this.descendInput(node.item).asSafe()});\n`;
            break;
        case 'list.show':
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.list.id)}", element: "checkbox", value: true }, runtime);\n`;
            break;

        case 'looks.backwardLayers':
            if (!this.target.isStage) {
                this.source += `target.goBackwardLayers(${this.descendInput(node.layers).asNumber()});\n`;
            }
            break;
        case 'looks.clearEffects':
            this.source += 'target.clearEffects();\n';
            break;
        case 'looks.changeEffect':
            if (this.target.effects.hasOwnProperty(node.effect)) {
                this.source += `target.setEffect("${sanitize(node.effect)}", runtime.ext_scratch3_looks.clampEffect("${sanitize(node.effect)}", ${this.descendInput(node.value).asNumber()} + target.effects["${sanitize(node.effect)}"]));\n`;
            }
            break;
        case 'looks.changeSize':
            this.source += `target.setSize(target.size + ${this.descendInput(node.size).asNumber()});\n`;
            break;
        case 'looks.forwardLayers':
            if (!this.target.isStage) {
                this.source += `target.goForwardLayers(${this.descendInput(node.layers).asNumber()});\n`;
            }
            break;
        case 'looks.goToBack':
            if (!this.target.isStage) {
                this.source += 'target.goToBack();\n';
            }
            break;
        case 'looks.goToFront':
            if (!this.target.isStage) {
                this.source += 'target.goToFront();\n';
            }
            break;
        case 'looks.hide':
            this.source += 'target.setVisible(false);\n';
            this.source += 'runtime.ext_scratch3_looks._renderBubble(target);\n';
            break;
        case 'looks.nextBackdrop':
            this.source += 'runtime.ext_scratch3_looks._setBackdrop(stage, stage.currentCostume + 1, true);\n';
            break;
        case 'looks.nextCostume':
            this.source += 'target.setCostume(target.currentCostume + 1);\n';
            break;
        case 'looks.setEffect':
            if (this.target.effects.hasOwnProperty(node.effect)) {
                this.source += `target.setEffect("${sanitize(node.effect)}", runtime.ext_scratch3_looks.clampEffect("${sanitize(node.effect)}", ${this.descendInput(node.value).asNumber()}));\n`;
            }
            break;
        case 'looks.setSize':
            this.source += `target.setSize(${this.descendInput(node.size).asNumber()});\n`;
            break;
        case 'looks.show':
            this.source += 'target.setVisible(true);\n';
            this.source += 'runtime.ext_scratch3_looks._renderBubble(target);\n';
            break;
        case 'looks.switchBackdrop':
            this.source += `runtime.ext_scratch3_looks._setBackdrop(stage, ${this.descendInput(node.backdrop).asSafe()});\n`;
            break;
        case 'looks.switchCostume':
            this.source += `runtime.ext_scratch3_looks._setCostume(target, ${this.descendInput(node.costume).asSafe()});\n`;
            break;

        case 'motion.changeX':
            this.source += `target.setXY(target.x + ${this.descendInput(node.dx).asNumber()}, target.y);\n`;
            break;
        case 'motion.changeY':
            this.source += `target.setXY(target.x, target.y + ${this.descendInput(node.dy).asNumber()});\n`;
            break;
        case 'motion.ifOnEdgeBounce':
            this.source += `runtime.ext_scratch3_motion._ifOnEdgeBounce(target);\n`;
            break;
        case 'motion.setDirection':
            this.source += `target.setDirection(${this.descendInput(node.direction).asNumber()});\n`;
            break;
        case 'motion.setRotationStyle':
            this.source += `target.setRotationStyle("${sanitize(node.style)}");\n`;
            break;
        case 'motion.setX': // fallthrough
        case 'motion.setY': // fallthrough
        case 'motion.setXY': {
            this.descendedIntoModulo = false;
            const x = 'x' in node ? this.descendInput(node.x).asNumber() : 'target.x';
            const y = 'y' in node ? this.descendInput(node.y).asNumber() : 'target.y';
            this.source += `target.setXY(${x}, ${y});\n`;
            if (this.descendedIntoModulo) {
                this.source += `if (target.interpolationData) target.interpolationData = null;\n`;
            }
            break;
        }
        case 'motion.step':
            this.source += `runtime.ext_scratch3_motion._moveSteps(${this.descendInput(node.steps).asNumber()}, target);\n`;
            break;

        case 'noop':
            break;

        case 'pen.clear':
            this.source += `${PEN_EXT}.clear();\n`;
            break;
        case 'pen.down':
            this.source += `${PEN_EXT}._penDown(target);\n`;
            break;
        case 'pen.changeParam':
            this.source += `${PEN_EXT}._setOrChangeColorParam(${this.descendInput(node.param).asString()}, ${this.descendInput(node.value).asNumber()}, ${PEN_STATE}, true);\n`;
            break;
        case 'pen.changeSize':
            this.source += `${PEN_EXT}._changePenSizeBy(${this.descendInput(node.size).asNumber()}, target);\n`;
            break;
        case 'pen.legacyChangeHue':
            this.source += `${PEN_EXT}._changePenHueBy(${this.descendInput(node.hue).asNumber()}, target);\n`;
            break;
        case 'pen.legacyChangeShade':
            this.source += `${PEN_EXT}._changePenShadeBy(${this.descendInput(node.shade).asNumber()}, target);\n`;
            break;
        case 'pen.legacySetHue':
            this.source += `${PEN_EXT}._setPenHueToNumber(${this.descendInput(node.hue).asNumber()}, target);\n`;
            break;
        case 'pen.legacySetShade':
            this.source += `${PEN_EXT}._setPenShadeToNumber(${this.descendInput(node.shade).asNumber()}, target);\n`;
            break;
        case 'pen.setColor':
            this.source += `${PEN_EXT}._setPenColorToColor(${this.descendInput(node.color).asColor()}, target);\n`;
            break;
        case 'pen.setParam':
            this.source += `${PEN_EXT}._setOrChangeColorParam(${this.descendInput(node.param).asString()}, ${this.descendInput(node.value).asNumber()}, ${PEN_STATE}, false);\n`;
            break;
        case 'pen.setSize':
            this.source += `${PEN_EXT}._setPenSizeTo(${this.descendInput(node.size).asNumber()}, target);\n`;
            break;
        case 'pen.stamp':
            this.source += `${PEN_EXT}._stamp(target);\n`;
            break;
        case 'pen.up':
            this.source += `${PEN_EXT}._penUp(target);\n`;
            break;

        case 'procedures.call': {
            const procedureCode = node.code;
            const procedureVariant = node.variant;
            const procedureData = this.ir.procedures[procedureVariant];
            if (procedureData.stack === null) {
                // TODO still need to evaluate arguments
                break;
            }

            const yieldForRecursion = !this.isWarp && procedureCode === this.script.procedureCode;
            if (yieldForRecursion) {
                this.yieldNotWarp();
            }

            if (procedureData.yields) {
                this.source += 'yield* ';
            }
            this.source += `thread.procedures["${sanitize(procedureVariant)}"](`;
            const args = [];
            for (const input of node.arguments) {
                args.push(this.descendInput(input).asSafe());
            }
            this.source += args.join(',');
            this.source += ');\n';

            this.resetVariableInputs();
            break;
        }
        case 'procedures.return':
            this.stopScriptAndReturn(this.descendInput(node.value).asSafe());
            break;

        case 'timer.reset':
            this.source += 'runtime.ioDevices.clock.resetProjectTimer();\n';
            break;

        case 'tw.debugger':
            this.source += 'debugger;\n';
            break;

        case 'var.hide':
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.variable.id)}", element: "checkbox", value: false }, runtime);\n`;
            break;
        case 'var.set': {
            const variable = this.descendVariable(node.variable);
            const value = this.descendInput(node.value);
            variable.setInput(value);
            this.source += `${variable.source} = ${value.asSafe()};\n`;
            if (node.variable.isCloud) {
                this.source += `runtime.ioDevices.cloud.requestUpdateVariable("${sanitize(node.variable.name)}", ${variable.source});\n`;
            }
            break;
        }
        case 'var.show':
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.variable.id)}", element: "checkbox", value: true }, runtime);\n`;
            break;

        case 'visualReport': {
            return [
                ...this.descendInput(node.input),
                new BytecodeInstruction(InstructionType.Return, ReturnReason.VisualReport)
            ];
        }

        default:
            log.warn(`JS: Unknown stacked block: ${node.kind}`, node);
            throw new Error(`JS: Unknown stacked block: ${node.kind}`);
        }
    }

    retire () {
        // After running retire() (sets thread status and cleans up some unused data), we need to return to the event loop.
        // When in a procedure, return will only send us back to the previous procedure, so instead we yield back to the sequencer.
        // Outside of a procedure, return will correctly bring us back to the sequencer.
        if (this.isProcedure) {
            this.source += 'retire(); yield;\n';
        } else {
            this.source += 'retire(); return;\n';
        }
    }

    stopScript () {
        if (this.isProcedure) {
            this.source += 'return "";\n';
        } else {
            this.retire();
        }
    }

    /**
     * @param {string} valueJS JS code of value to return.
     */
    stopScriptAndReturn (valueJS) {
        if (this.isProcedure) {
            this.source += `return ${valueJS};\n`;
        } else {
            this.retire();
        }
    }

    /**
     * Checks if the browser is compatible with BigUint64Array and alerts if it
     * isn't.
     * @returns a boolean indicating support
     */
    compatCheck () {
        try {
            // eslint-disable-next-line no-undef
            const _ = new BigUint64Array(0);
        } catch (_) {
            // eslint-disable-next-line no-alert
            alert("Your browser doesn't support the technologies needed.");
            return false;
        }
        return true;
    }

    /**
     * Compile this script.
     * @returns {Function} The factory function for the script.
     */
    compile () {
        if (!this.compatCheck()) throw new Error('stopping due to no support');
        let stackBytecodeInstructions = [];
        if (this.script.stack) {
            log.debug('descending into', this.script.stack);
            stackBytecodeInstructions = this.descendStack(this.script.stack, new Frame(false));
        }
        // Process the bytecode
        const bytecodeBuffer = new ArrayBuffer(stackBytecodeInstructions.length * 8);
        stackBytecodeInstructions.forEach((instruction, index) => {
            instruction.writeToBuffer(bytecodeBuffer, index * 8);
        });
        // I think eslint is set up to support older browsers; compat check
        // already exists
        // eslint-disable-next-line no-undef
        const bytecode = new BigUint64Array(bytecodeBuffer);
        // Process the constants, vars, lists
        const constants = new Map();
        this.constants.forEach((constant, index) => {
            constants.set(index, constant);
        });
        const lists = new Map();
        const variables = new Map();
        const refreshVars = (target, stage) => {
            lists.clear();
            this.lists.forEach((listID, index) => {
                let list;
                if (target.variables.hasOwnProperty(listID)) {
                    // Assume it's on the sprite, not the stage
                    list = target.variables[listID].value;
                } else {
                    list = stage.variables[listID].value;
                }
                lists.set(index, list.join('\0'));
            });
            variables.clear();
            this.variables.forEach((variableID, index) => {
                let variable;
                if (target.variables.hasOwnProperty(variableID)) {
                    // Assume it's on the sprite, not the stage
                    variable = target.variables[variableID].value;
                } else {
                    variable = stage.variables[variableID].value;
                }
                variables.set(index, variable);
            });
        };
        
        this.stopScript();

        const fn = () => jsexecute.scopedExecute(function*(globalState) {
            yield;
            const target = globalState.thread.target;
            log.debug(target);
            const runtime = target.runtime;
            const stage = runtime.getTargetForStage();
            refreshVars(target, stage);
            log.debug('running with', bytecode, constants, variables, lists);
            log.debug(Object.fromEntries(run_sync(
                /* initial_project_counter: */ 0,
                /* initial_stack: */ [],
                bytecode,
                constants,
                variables,
                lists
            )));
            log.debug('hi there, running');
            log.debug(globalState);
            // Finish thread
            runtime.sequencer.retireThread(globalState.thread);
        });

        if (this.debug) {
            log.info(`bytecode: ${this.target.getName()}: compiled`, stackBytecodeInstructions);
        }

        if (JSGenerator.testingApparatus) {
            log.warn('uh, not sure what the testingApparatus is for, here it is if you care:', JSGenerator.testingApparatus);
        }

        return fn;
    }
}

// Test hook used by automated snapshot testing.
JSGenerator.testingApparatus = null;

module.exports = JSGenerator;
