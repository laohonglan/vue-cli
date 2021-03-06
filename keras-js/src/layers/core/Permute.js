import Layer from '../../Layer'
import Tensor from '../../Tensor'
import { webgl2 } from '../../WebGL2'
import _ from 'lodash'
import ops from 'ndarray-ops'
import mapInputProgramSource from '../../webgl/mapInput.glsl'

/**
 * Permute layer class
 * Note there is no concept of batch size in these layers (single-batch), so dim numbers 1 less
 * i.e., dim 1 in keras corresponds to dim 0 here, etc.
 */
export default class Permute extends Layer {
  /**
   * Creates a Permute layer
   *
   * @param {Object} [attrs] - layer config attributes
   * @param {number[]} [attrs.dims]
   */
  constructor(attrs = {}) {
    super(attrs)
    this.layerClass = 'Permute'

    const { dims = [] } = attrs
    this.dims = dims.map(dim => dim - 1)

    // GPU setup
    if (this.gpu) {
      this.mapInputProgram = webgl2.compileProgram(mapInputProgramSource)
    }
  }

  /**
   * Layer computational logic
   *
   * @param {Tensor} x
   * @returns {Tensor}
   */
  call(x) {
    if (x.tensor.shape.length <= 1 || _.isEqual(_.range(x.tensor.shape.length), this.dims)) {
      this.output = x
      return this.output
    }

    if (this.gpu) {
      this._callGPU(x)
    } else {
      this._callCPU(x)
    }
    return this.output
  }

  /**
   * CPU call
   *
   * @param {Tensor} x
   */
  _callCPU(x) {
    if (this.dims.length !== x.tensor.shape.length) {
      this.throwError('The specified dims permutation must match the number of dimensions.')
    }

    const outputShape = this.dims.map(i => x.tensor.shape[i])
    this.output = new Tensor([], outputShape)
    ops.assign(this.output.tensor, x.tensor.transpose(...this.dims))
  }

  /**
   * Creates row/col index mappings to map input texture to output texture
   */
  _createIndexMap() {
    if (this.indexMap) {
      return
    }

    const indices = new Tensor([], this.inputShape, { type: Int32Array })
    const indicesRow = new Tensor([], this.inputShape, { type: Int32Array })
    const indicesCol = new Tensor([], this.inputShape, { type: Int32Array })

    if (this.inputShape.length === 2) {
      for (let i = 0; i < this.inputShape[0]; i++) {
        ops.assigns(indicesRow.tensor.pick(i, null), i)
      }
    } else if (this.inputShape.length === 3) {
      for (let i = 0; i < this.inputShape[0]; i++) {
        for (let j = 0; j < this.inputShape[1]; j++) {
          ops.assigns(indicesRow.tensor.pick(i, j, null), i * this.inputShape[1] + j)
        }
      }
    } else if (this.inputShape.length === 4) {
      for (let i = 0; i < this.inputShape[0]; i++) {
        for (let j = 0; j < this.inputShape[1]; j++) {
          for (let k = 0; k < this.inputShape[2]; k++) {
            ops.assigns(
              indicesRow.tensor.pick(i, j, k, null),
              i * this.inputShape[1] * this.inputShape[2] + j * this.inputShape[2] + k
            )
          }
        }
      }
    }
    for (let c = 0; c < _.last(this.inputShape); c++) {
      ops.assigns(indicesCol.tensor.pick(...Array(this.inputShape.length - 1).fill(null), c), c)
    }
    // i * cols + j
    ops.muls(indices.tensor, indicesRow.tensor, _.last(this.inputShape))
    ops.addeq(indices.tensor, indicesCol.tensor)

    const outputShape = this.dims.map(i => this.inputShape[i])
    this.indexMap = new Tensor([], outputShape, { type: Int32Array })
    ops.assign(this.indexMap.tensor, indices.tensor.transpose(...this.dims))
    if (outputShape.length > 2) {
      this.indexMap.reshapeTo2D()
    }

    this.indexMap.createGLTexture({ type: '2d', format: 'int' })
  }

  /**
   * GPU call
   *
   * @param {Tensor} x
   */
  _callGPU(x) {
    if (!x.glTexture) {
      this.inputShape = x.tensor.shape
      if (x.tensor.shape.length <= 2) {
        x.createGLTexture({ type: '2d', format: 'float' })
      } else if (x.tensor.shape.length > 2 && !x.is2DReshaped) {
        x.reshapeTo2D()
        x.createGLTexture({ type: '2d', format: 'float' })
      }
    } else if (x.is2DReshaped || x.is2DSquareReshaped) {
      this.inputShape = x.originalShape
    } else {
      this.inputShape = x.tensor.shape
    }
    this._createIndexMap()

    if (!this.output) {
      const outputShape = this.dims.map(i => this.inputShape[i])
      this.output = new Tensor([], outputShape)
      if (outputShape.length > 2) {
        this.output.reshapeTo2D()
      }
      this.output.createGLTexture({ type: '2d', format: 'float' })
    }

    webgl2.runProgram({
      program: this.mapInputProgram,
      output: this.output,
      inputs: [{ input: x, name: 'x' }, { input: this.indexMap, name: 'indexMap' }],
      uniforms: [{ value: x.glTextureShape[1], type: 'int', name: 'inputCols' }]
    })

    // GPU -> CPU data transfer
    if (this.outbound.length === 0) {
      this.output.transferFromGLTexture()
      if (this.output.is2DReshaped) {
        this.output.reshapeFrom2D()
      } else if (this.output.is2DSquareReshaped) {
        this.output.reshapeFrom2DSquare()
      }
    }
  }
}
