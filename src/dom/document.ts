import CustomRule from '../rule/custom-rule';

import { ConfigureFileJSONRuleOption } from '../ruleset/JSONInterface';

import Ruleset from '../ruleset';

import { Indentation, NodeType } from '.';

import CommentNode from './comment-node';
import Element from './element';
import EndTagNode from './end-tag-node';
import GhostNode from './ghost-node';
import InvalidNode from './invalid-node';
import Node from './node';
import OmittedElement from './omitted-element';
import RawText from './raw-text';
import TextNode from './text-node';

import { syncWalk, SyncWalker } from './sync-walk';
import { Walker } from './walk';

export default class Document<T, O> {
	public rule: CustomRule<T, O> | null = null;
	public readonly isFragment: boolean;

	private _raw: string;
	private _tree: (Node<T, O> | GhostNode<T, O>)[] = [];
	private _list: (Node<T, O> | GhostNode<T, O>)[] = [];
	private _ruleset: Ruleset | null = null;

	// tslint:disable-next-line:cyclomatic-complexity
	constructor(
		nodeTree: (Node<T, O> | GhostNode<T, O>)[],
		rawHtml: string,
		isFragment: boolean,
		ruleset?: Ruleset,
	) {
		this._raw = rawHtml;
		this._tree = nodeTree;
		this.isFragment = isFragment;
		this._ruleset = ruleset || null;

		const pos: SortableNode<T, O>[] = [];

		let prevLine = 1;
		let prevCol = 1;
		let currentStartOffset = 0;
		let currentEndOffset = 0;

		syncWalk<T, O>(nodeTree, node => {
			if (node instanceof Node) {
				currentStartOffset = node.location.startOffset;

				const diff = currentStartOffset - currentEndOffset;
				if (diff > 0) {
					const html = rawHtml.slice(
						currentEndOffset,
						currentStartOffset,
					);
					// console.log(`diff: ${diff} => "${spaces.replace(/\n/g, '⏎').replace(/\t/g, '→').replace(/\s/g, '␣')}"`);

					if (/^\s+$/.test(html)) {
						const spaces = html;
						const textNode = new TextNode<T, O>(
							'#ws',
							spaces,
							prevLine,
							prevCol,
							currentEndOffset,
							node.prevNode,
							node,
							node.parentNode,
						);
						node.prevNode = textNode;

						pos.push({
							node: textNode,
							startOffset: currentEndOffset,
							endOffset: currentEndOffset + spaces.length,
						});
					} else if (/^<\/[a-z0-9][a-z0-9:-]*>$/i) {
						// close tag
					} else {
						throw new Error(`what?!`);
					}
				}

				currentEndOffset = currentStartOffset + node.raw.length;

				prevLine = node.location.endLine;
				prevCol = node.location.endCol;
			}

			pos.push({
				node,
				startOffset: currentStartOffset,
				endOffset: currentEndOffset,
			});
		});

		pos.sort((a, b) => a.startOffset - b.startOffset);

		let lastNode: Node<T, O> | null = null;
		for (const { node, startOffset, endOffset } of pos) {
			if (node instanceof GhostNode) {
				continue;
			}
			lastNode = node;
		}

		// remove duplicated node
		const stack: { [pos: string]: number } = {};
		const removeIndexes: number[] = [];
		pos.forEach(({ node, startOffset, endOffset }, i) => {
			if (node instanceof Node) {
				const id = `${node.line}:${node.col}:${node.location.endLine}:${
					node.location.endCol
				}`;
				if (stack[id] != null) {
					const iA = stack[id];
					const iB = i;
					const a = pos[iA].node;
					const b = node;
					if (a instanceof InvalidNode && b instanceof InvalidNode) {
						removeIndexes.push(iB);
					} else if (a instanceof InvalidNode) {
						removeIndexes.push(iA);
					} else {
						removeIndexes.push(iB);
					}
				}
				stack[id] = i;
			}
		});
		let r = pos.length;
		while (r--) {
			if (removeIndexes.includes(r)) {
				pos.splice(r, 1);
			}
		}

		// create Last spaces
		pos.forEach(({ node, startOffset, endOffset }, i) => {
			if (i === pos.length - 1) {
				const lastTextContent = rawHtml.slice(endOffset);
				if (!lastTextContent) {
					return;
				}
				const line = lastNode ? lastNode.location.endLine : 0;
				const col = lastNode ? lastNode.location.endCol : 0;
				const lastTextNode = new TextNode<T, O>(
					'#text',
					lastTextContent,
					line,
					col,
					endOffset,
					lastNode || null,
					node,
					null,
				);
				if (lastNode) {
					lastNode.nextNode = lastTextNode;
				}
				pos.push({
					node: lastTextNode,
					startOffset: endOffset,
					endOffset: endOffset + lastTextContent.length,
				});
			}
		});

		this._list = [];

		let prevSyntaxicalNode: Node<T, O> | null = null;
		pos.map(p => p.node).forEach(node => {
			if (node instanceof Node) {
				node.prevSyntaxicalNode = prevSyntaxicalNode;
				prevSyntaxicalNode = node;
				if (node.prevSyntaxicalNode instanceof TextNode) {
					const prevSyntaxicalTextNode = node.prevSyntaxicalNode;

					// concat contiguous textNodes
					if (node instanceof TextNode) {
						// @ts-ignore
						prevSyntaxicalTextNode.location.endLine =
							node.location.endLine;
						// @ts-ignore
						prevSyntaxicalTextNode.location.endCol =
							node.location.endCol;
						// @ts-ignore
						prevSyntaxicalTextNode.location.endOffset =
							node.location.endOffset;
						prevSyntaxicalTextNode.fix(
							prevSyntaxicalTextNode.raw + node.raw,
						);
						prevSyntaxicalNode = prevSyntaxicalTextNode;
						return;
					}
				}
			}
			this._list.push(node);
		});

		for (const node of this._list) {
			if (node instanceof Node) {
				// set self
				node.document = this;

				/**
				 * Indentation of TextNode
				 */
				if (node instanceof TextNode) {
					const textNode = node;
					if (!(node instanceof RawText)) {
						const matched = node.raw.match(
							/^(\s*(?:\r?\n)+\s*)(?:[^\s]+)/,
						);
						if (matched) {
							const spaces = matched[1];
							if (spaces) {
								const spaceLines = spaces.split(/\r?\n/);
								const line = spaceLines.length + node.line - 1;
								const lastSpace = spaceLines.pop();
								if (lastSpace != null) {
									node.indentation = new Indentation(
										node,
										lastSpace,
										line,
									);
								}
							}
						}
					}
					/**
					 * Indentation of Element etc.
					 */
				} else if (node.prevSyntaxicalNode instanceof TextNode) {
					const prevSyntaxicalTextNode: TextNode<T, O> =
						node.prevSyntaxicalNode;

					if (!(prevSyntaxicalTextNode instanceof RawText)) {
						const matched = prevSyntaxicalTextNode.raw.match(
							/\r?\n([ \t]*)$/,
						);
						if (matched) {
							const spaces = matched[1];
							if (spaces != null) {
								node.indentation = new Indentation(
									prevSyntaxicalTextNode,
									spaces,
									node.line,
								);
							}
						} else if (
							node.prevNode &&
							node.prevNode instanceof Node &&
							node.prevNode.location.startOffset === 0
						) {
							const spaces = node.prevNode.raw;
							node.indentation = new Indentation(
								prevSyntaxicalTextNode,
								spaces,
								node.line,
							);
						}
					}
				} else if (node.location.startOffset === 0) {
					node.indentation = new Indentation(null, '', node.line);
					// node.indentation = {
					// 	type: 'none',
					// 	width: 0,
					// 	raw: '',
					// 	line: node.line,
					// };
				}
			}
		}

		if (this._ruleset) {
			// nodeRules
			const _ruleset = this._ruleset;
			// tslint:disable-next-line:cyclomatic-complexity
			this.syncWalk(node => {
				for (const ruleName in _ruleset.rules) {
					if (_ruleset.rules.hasOwnProperty(ruleName)) {
						const rule = _ruleset.rules[ruleName];
						node.rules[ruleName] = rule;
					}
				}
				for (const nodeRule of _ruleset.nodeRules) {
					if (nodeRule.rules) {
						for (const ruleName in nodeRule.rules) {
							if (nodeRule.rules.hasOwnProperty(ruleName)) {
								const rule = nodeRule.rules[ruleName];
								if (nodeRule.tagName || nodeRule.selector) {
									if (nodeRule.tagName === node.nodeName) {
										node.rules[ruleName] = rule;
									} else if (
										nodeRule.selector &&
										node instanceof Element
									) {
										if (node.matches(nodeRule.selector)) {
											node.rules[ruleName] = rule;
										}
									}
								}
							}
						}
					}
					if (node instanceof Element) {
						if (node.nodeName.toLowerCase() === nodeRule.tagName) {
							node.obsolete = !!nodeRule.obsolete;
						}
					}
				}
			});
			// childNodeRules
			const stackNodes: [
				(Element<T, O> | OmittedElement<T, O>),
				string,
				boolean | ConfigureFileJSONRuleOption<null, {}>,
				boolean
			][] = [];
			this.syncWalk(node => {
				if (node instanceof Element || node instanceof OmittedElement) {
					for (const nodeRule of _ruleset.childNodeRules) {
						if (nodeRule.rules) {
							for (const ruleName in nodeRule.rules) {
								if (nodeRule.rules.hasOwnProperty(ruleName)) {
									const rule = nodeRule.rules[ruleName];
									if (nodeRule.tagName || nodeRule.selector) {
										if (
											nodeRule.tagName === node.nodeName
										) {
											stackNodes.push([
												node,
												ruleName,
												rule,
												!!nodeRule.inheritance,
											]);
										} else if (
											nodeRule.selector &&
											node instanceof Element
										) {
											if (
												node.matches(nodeRule.selector)
											) {
												stackNodes.push([
													node,
													ruleName,
													rule,
													!!nodeRule.inheritance,
												]);
											}
										}
									}
								}
							}
						}
					}
				}
			});
			for (const stackNode of stackNodes) {
				const node = stackNode[0];
				const ruleName = stackNode[1];
				const rule = stackNode[2];
				const inheritance = stackNode[3];
				if (inheritance) {
					syncWalk(node.childNodes, childNode => {
						childNode.rules[ruleName] = rule;
					});
				} else {
					for (const childNode of node.childNodes) {
						childNode.rules[ruleName] = rule;
					}
				}
			}
		}
	}

	public get raw() {
		return this._raw;
	}

	public get list() {
		return this._list;
	}

	public toString() {
		const s: string[] = [];
		this.syncWalk(node => {
			s.push(node.raw);
		});
		return s.join('');
	}

	/**
	 * @deprecated
	 */
	public fix() {
		const s: string[] = [];
		this.syncWalk(node => {
			s.push(node.raw);
		});
		return s.join('');
	}

	public toJSON() {
		return JSON.parse(JSON.stringify(this._tree));
	}

	public toDebugMap() {
		return this.list.map(n => {
			if (n instanceof Node) {
				return `[${n.line}:${n.col}]>[${n.location.endLine}:${
					n.location.endCol
				}](${n.location.startOffset},${n.location.endOffset})${
					n instanceof OmittedElement ? '???' : ''
				}${n.nodeName}: ${n
					.toString()
					.replace(/\n/g, '⏎')
					.replace(/\t/g, '→')
					.replace(/\s/g, '␣')}`;
			} else {
				return `[N/A]>[N/A](N/A)${n.nodeName}: ${n.toString()}`;
			}
		});
	}

	public async walk(walker: Walker<T, O>) {
		for (const node of this._list) {
			await walker(node);
		}
	}

	public async walkOn(
		type: 'Node',
		walker: Walker<T, O, Node<T, O>>,
	): Promise<void>;
	public async walkOn(
		type: 'Element',
		walker: Walker<T, O, Element<T, O>>,
	): Promise<void>;
	public async walkOn(
		type: 'Text',
		walker: Walker<T, O, TextNode<T, O>>,
	): Promise<void>;
	public async walkOn(
		type: 'Comment',
		walker: Walker<T, O, CommentNode<T, O>>,
	): Promise<void>;
	public async walkOn(
		type: 'EndTag',
		walker: Walker<T, O, EndTagNode<T, O>>,
	): Promise<void>;
	public async walkOn(
		type: NodeType,
		walker: Walker<T, O, any>, // tslint:disable-line:no-any
	): Promise<void> {
		for (const node of this._list) {
			if (node instanceof Node) {
				if (type === 'Node') {
					await walker(node);
				} else if (node.is(type)) {
					await walker(node);
				}
			}
		}
	}

	public syncWalk(walker: SyncWalker<T, O>) {
		for (const node of this._list) {
			walker(node);
		}
	}

	public syncWalkOn(type: 'Node', walker: SyncWalker<T, O, Node<T, O>>): void;
	public syncWalkOn(
		type: 'Element',
		walker: SyncWalker<T, O, Element<T, O>>,
	): void;
	public syncWalkOn(
		type: 'Text',
		walker: SyncWalker<T, O, TextNode<T, O>>,
	): void;
	public syncWalkOn(
		type: 'Comment',
		walker: SyncWalker<T, O, CommentNode<T, O>>,
	): void;
	public syncWalkOn(
		type: 'EndTag',
		walker: SyncWalker<T, O, EndTagNode<T, O>>,
	): void;
	// tslint:disable-next-line:no-any
	public syncWalkOn(type: NodeType, walker: SyncWalker<T, O, any>): void {
		for (const node of this._list) {
			if (node instanceof Node) {
				if (type === 'Node') {
					walker(node);
				} else if (node.is(type)) {
					walker(node);
				}
			}
		}
	}

	public getNode(index: number): Node<T, O> | GhostNode<T, O> | null {
		return this._tree[index];
	}

	public setRule(rule: CustomRule<T, O> | null) {
		this.rule = rule;
	}

	public get globalRule() {
		if (!this.rule) {
			throw new Error('Invalid call');
		}

		if (!this._ruleset) {
			throw new Error('Invalid call');
		}

		const name = this.rule.name;

		// @ts-ignore
		const rule: ConfigureFileJSONRuleOption<T, O> = this._ruleset.rules[
			name
		];
		if (rule == null) {
			throw new Error('Invalid call "rule" property.');
		}
		return this.rule.optimizeOption(rule);
	}
}

interface SortableNode<T, O> {
	node: Node<T, O> | GhostNode<T, O>;
	startOffset: number;
	endOffset: number;
}
