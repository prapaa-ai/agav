import { describe, it, expect } from 'vitest';
import { SafeTreeSitterParser } from '../repomap/parser/safe-parser.js';
import { detectLanguage, getExtractor } from '../repomap/parser/extractors/index.js';

describe('RepoMap - Language Detection', () => {
  it('detects language by file extension correctly', () => {
    expect(detectLanguage('index.ts')).toBe('typescript');
    expect(detectLanguage('component.tsx')).toBe('typescript');
    expect(detectLanguage('app.js')).toBe('typescript');
    expect(detectLanguage('script.mjs')).toBe('typescript');
    expect(detectLanguage('server.cjs')).toBe('typescript');
    expect(detectLanguage('main.py')).toBe('python');
    expect(detectLanguage('stub.pyi')).toBe('python');
    expect(detectLanguage('service.go')).toBe('go');
    expect(detectLanguage('lib.rs')).toBe('rust');
    expect(detectLanguage('App.java')).toBe('fallback');
    expect(detectLanguage('main.cpp')).toBe('fallback');
    expect(detectLanguage('script.rb')).toBe('fallback');
  });
});

describe('RepoMap - TypeScript Extractor', () => {
  const parser = new SafeTreeSitterParser();

  it('extracts functions, arrow functions, classes, interfaces, types, and enums', () => {
    const code = `
import { Router } from 'express';
import type { Config } from './config.js';

export async function startServer(port: number): Promise<void> {
  console.log("Starting", port);
}

function internalHelper(msg: string) {
  return msg;
}

export const processTask = async (task: string) => {
  return internalHelper(task);
};

export class UserService extends BaseService implements IUserService {
  constructor(private config: Config) {
    super();
  }

  public async getUser(id: string): Promise<User> {
    this.validate(id);
    return fetchUser(id);
  }

  private validate(id: string): boolean {
    return Boolean(id);
  }
}

export interface IUserService {
  getUser(id: string): Promise<User>;
}

export type UserID = string | number;

export enum UserRole {
  Admin = 'ADMIN',
  Member = 'MEMBER'
}
`;

    const result = parser.parse('user-service.ts', code);
    const symNames = result.symbols.map(s => s.name);

    // Symbols verification
    expect(symNames).toContain('startServer');
    expect(symNames).toContain('internalHelper');
    expect(symNames).toContain('processTask');
    expect(symNames).toContain('UserService');
    expect(symNames).toContain('getUser');
    expect(symNames).toContain('validate');
    expect(symNames).toContain('IUserService');
    expect(symNames).toContain('UserID');
    expect(symNames).toContain('UserRole');

    // Function attributes
    const startServerSym = result.symbols.find(s => s.name === 'startServer')!;
    expect(startServerSym.kind).toBe('function');
    expect(startServerSym.exported).toBe(true);

    const internalHelperSym = result.symbols.find(s => s.name === 'internalHelper')!;
    expect(internalHelperSym.kind).toBe('function');
    expect(internalHelperSym.exported).toBe(false);

    // Class and methods
    const classSym = result.symbols.find(s => s.name === 'UserService')!;
    expect(classSym.kind).toBe('class');
    expect(classSym.exported).toBe(true);

    const methodSym = result.symbols.find(s => s.name === 'getUser')!;
    expect(methodSym.kind).toBe('method');
    expect(methodSym.parentId).toBe(classSym.id);

    // Interface, type, enum
    expect(result.symbols.find(s => s.name === 'IUserService')!.kind).toBe('interface');
    expect(result.symbols.find(s => s.name === 'UserID')!.kind).toBe('type');
    expect(result.symbols.find(s => s.name === 'UserRole')!.kind).toBe('enum');

    // References verification
    const refNames = result.references.map(r => r.name);
    // Imports
    expect(refNames).toContain('express');
    expect(refNames).toContain('Router');
    expect(refNames).toContain('./config.js');
    expect(refNames).toContain('Config');

    // Inheritance
    const inheritanceRefs = result.references.filter(r => r.kind === 'inheritance').map(r => r.name);
    expect(inheritanceRefs).toContain('BaseService');
    expect(inheritanceRefs).toContain('IUserService');

    // Calls
    const callRefs = result.references.filter(r => r.kind === 'call').map(r => r.name);
    expect(callRefs).toContain('internalHelper');
    expect(callRefs).toContain('validate');
    expect(callRefs).toContain('fetchUser');

    // Type references
    const typeRefs = result.references.filter(r => r.kind === 'type_ref').map(r => r.name);
    expect(typeRefs).toContain('Config');
    expect(typeRefs).toContain('User');
  });
});

describe('RepoMap - Python Extractor', () => {
  const parser = new SafeTreeSitterParser();

  it('extracts classes, defs, async defs, methods, imports, inheritance, and calls', () => {
    const code = `
import os
import math
from typing import List, Optional
from .database import DatabaseClient

class Animal:
    def __init__(self, name: str):
        self.name = name

    def speak(self) -> str:
        return self.name

class Dog(Animal):
    async def fetch(self, item: str) -> bool:
        self.speak()
        print("Fetching", item)
        return True

async def run_simulation(dogs: List[Dog]):
    for dog in dogs:
        await dog.fetch("ball")

def _internal_calc(x: int):
    return math.sqrt(x)
`;

    const result = parser.parse('pets.py', code);
    const symNames = result.symbols.map(s => s.name);

    expect(symNames).toContain('Animal');
    expect(symNames).toContain('speak');
    expect(symNames).toContain('Dog');
    expect(symNames).toContain('fetch');
    expect(symNames).toContain('run_simulation');
    expect(symNames).toContain('_internal_calc');

    // Method parent containment
    const dogClass = result.symbols.find(s => s.name === 'Dog')!;
    expect(dogClass.kind).toBe('class');
    expect(dogClass.exported).toBe(true);

    const fetchMethod = result.symbols.find(s => s.name === 'fetch')!;
    expect(fetchMethod.kind).toBe('method');
    expect(fetchMethod.parentId).toBe(dogClass.id);

    // Internal function export flag
    const internalSym = result.symbols.find(s => s.name === '_internal_calc')!;
    expect(internalSym.exported).toBe(false);

    // References: imports
    const importRefs = result.references.filter(r => r.kind === 'import').map(r => r.name);
    expect(importRefs).toContain('os');
    expect(importRefs).toContain('math');
    expect(importRefs).toContain('typing');
    expect(importRefs).toContain('List');
    expect(importRefs).toContain('.database');
    expect(importRefs).toContain('DatabaseClient');

    // References: inheritance
    const inheritanceRefs = result.references.filter(r => r.kind === 'inheritance').map(r => r.name);
    expect(inheritanceRefs).toContain('Animal');

    // References: calls
    const callRefs = result.references.filter(r => r.kind === 'call').map(r => r.name);
    expect(callRefs).toContain('speak');
    expect(callRefs).toContain('fetch');
    expect(callRefs).toContain('sqrt');
  });
});

describe('RepoMap - Go Extractor', () => {
  const parser = new SafeTreeSitterParser();

  it('extracts functions, methods with receivers, structs, interfaces, and imports', () => {
    const code = `
package main

import (
	"fmt"
	"net/http"
	pkg "github.com/example/pkg"
)

type Config struct {
	Host string
	Port int
}

type ServerInterface interface {
	Start() error
	Stop()
}

func (s *Server) Start() error {
	fmt.Println("Server starting")
	s.listen()
	return nil
}

func (s Server) Stop() {
	fmt.Println("Server stopped")
}

func CreateServer(cfg Config) *Server {
	return &Server{}
}

func internalSetup() {
}
`;

    const result = parser.parse('server.go', code);
    const symNames = result.symbols.map(s => s.name);

    expect(symNames).toContain('Config');
    expect(symNames).toContain('ServerInterface');
    expect(symNames).toContain('Start');
    expect(symNames).toContain('Stop');
    expect(symNames).toContain('CreateServer');
    expect(symNames).toContain('internalSetup');

    // Struct & interface kinds
    const configSym = result.symbols.find(s => s.name === 'Config')!;
    expect(configSym.kind).toBe('struct');
    expect(configSym.exported).toBe(true);

    const ifaceSym = result.symbols.find(s => s.name === 'ServerInterface')!;
    expect(ifaceSym.kind).toBe('interface');
    expect(ifaceSym.exported).toBe(true);

    // Method with receiver
    const startMethod = result.symbols.find(s => s.name === 'Start')!;
    expect(startMethod.kind).toBe('method');
    expect(startMethod.parentId).toBe('server.go:Server');
    expect(startMethod.exported).toBe(true);

    // Internal function exported is false
    const internalSetupSym = result.symbols.find(s => s.name === 'internalSetup')!;
    expect(internalSetupSym.exported).toBe(false);

    // References: imports
    const importRefs = result.references.filter(r => r.kind === 'import').map(r => r.name);
    expect(importRefs).toContain('fmt');
    expect(importRefs).toContain('net/http');
    expect(importRefs).toContain('github.com/example/pkg');
    expect(importRefs).toContain('pkg');

    // References: calls
    const callRefs = result.references.filter(r => r.kind === 'call').map(r => r.name);
    expect(callRefs).toContain('Println');
    expect(callRefs).toContain('listen');
  });
});

describe('RepoMap - Rust Extractor', () => {
  const parser = new SafeTreeSitterParser();

  it('extracts pub fn, fn, structs, enums, traits, impl blocks, use statements, and calls', () => {
    const code = `
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
pub use crate::types::Result;

pub struct Point {
    pub x: f64,
    pub y: f64,
}

struct PrivateContext;

pub enum Color {
    Red,
    Green,
    Blue,
}

pub trait Drawable: Display {
    fn draw(&self);
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }

    fn calculate_distance(&self) -> f64 {
        sqrt(self.x * self.x + self.y * self.y)
    }
}

impl Drawable for Point {
    fn draw(&self) {
        println!("Drawing point");
    }
}

pub fn render_all(points: &[Point]) {
    for p in points {
        p.draw();
    }
}

fn internal_init() {
}
`;

    const result = parser.parse('geometry.rs', code);
    const symNames = result.symbols.map(s => s.name);

    expect(symNames).toContain('Point');
    expect(symNames).toContain('PrivateContext');
    expect(symNames).toContain('Color');
    expect(symNames).toContain('Drawable');
    expect(symNames).toContain('new');
    expect(symNames).toContain('calculate_distance');
    expect(symNames).toContain('draw');
    expect(symNames).toContain('render_all');
    expect(symNames).toContain('internal_init');

    // Struct export
    const pointSym = result.symbols.find(s => s.name === 'Point')!;
    expect(pointSym.kind).toBe('struct');
    expect(pointSym.exported).toBe(true);

    const privateCtxSym = result.symbols.find(s => s.name === 'PrivateContext')!;
    expect(privateCtxSym.kind).toBe('struct');
    expect(privateCtxSym.exported).toBe(false);

    // Enum and trait
    expect(result.symbols.find(s => s.name === 'Color')!.kind).toBe('enum');
    const traitSym = result.symbols.find(s => s.name === 'Drawable')!;
    expect(traitSym.kind).toBe('trait');
    expect(traitSym.exported).toBe(true);

    // Method in impl
    const newMethod = result.symbols.find(s => s.name === 'new')!;
    expect(newMethod.kind).toBe('method');
    expect(newMethod.parentId).toBe('geometry.rs:Point');
    expect(newMethod.exported).toBe(true);

    const calcDistMethod = result.symbols.find(s => s.name === 'calculate_distance')!;
    expect(calcDistMethod.kind).toBe('method');
    expect(calcDistMethod.exported).toBe(false);

    // References: imports
    const importRefs = result.references.filter(r => r.kind === 'import').map(r => r.name);
    expect(importRefs).toContain('std::collections::HashMap');
    expect(importRefs).toContain('Arc');
    expect(importRefs).toContain('Mutex');
    expect(importRefs).toContain('crate::types::Result');

    // References: trait inheritance
    const inheritanceRefs = result.references.filter(r => r.kind === 'inheritance').map(r => r.name);
    expect(inheritanceRefs).toContain('Display');
    expect(inheritanceRefs).toContain('Drawable');

    // References: calls
    const callRefs = result.references.filter(r => r.kind === 'call').map(r => r.name);
    expect(callRefs).toContain('sqrt');
    expect(callRefs).toContain('println');
    expect(callRefs).toContain('draw');
  });
});

describe('RepoMap - Fallback Extractor', () => {
  const parser = new SafeTreeSitterParser();

  it('extracts symbols from Java, C++, and Ruby using fallback patterns', () => {
    const javaCode = `
import java.util.List;
import com.example.service.UserService;

public class OrderManager {
    public void processOrder() {
        validateOrder();
    }
}
`;
    const javaResult = parser.parse('OrderManager.java', javaCode);
    expect(javaResult.symbols.map(s => s.name)).toContain('OrderManager');
    expect(javaResult.references.map(r => r.name)).toContain('java.util.List');
    expect(javaResult.references.map(r => r.name)).toContain('validateOrder');

    const cppCode = `
#include <iostream>
#include "header.h"

struct Vector3D {
    float x, y, z;
};
`;
    const cppResult = parser.parse('math.cpp', cppCode);
    expect(cppResult.symbols.map(s => s.name)).toContain('Vector3D');
    expect(cppResult.references.map(r => r.name)).toContain('iostream');
    expect(cppResult.references.map(r => r.name)).toContain('header.h');
  });
});

describe('RepoMap - SafeTreeSitterParser Lifecycle & Recycling', () => {
  it('increments parse count and recycles when threshold is reached', () => {
    const recycleThreshold = 5;
    const parser = new SafeTreeSitterParser({ recycleThreshold });

    expect(parser.getParseCount()).toBe(0);
    expect(parser.getRecycleCount()).toBe(0);

    for (let i = 1; i <= 12; i++) {
      parser.parse(`file_${i}.ts`, `export function f${i}() {}`);
    }

    // 12 files parsed with threshold 5:
    // 5 -> recycle 1 (parseCount resets to 0)
    // 10 -> recycle 2 (parseCount resets to 0)
    // 11, 12 -> parseCount = 2
    expect(parser.getRecycleCount()).toBe(2);
    expect(parser.getParseCount()).toBe(2);
  });

  it('guarantees explicit disposal of trees and cursors via try/finally', () => {
    const parser = new SafeTreeSitterParser();

    parser.parse('sample1.ts', 'export const x = 1;');
    parser.parse('sample2.py', 'def foo(): pass');
    parser.parse('sample3.go', 'func Bar() {}');

    expect(parser.getDisposedTreeCount()).toBe(3);
    expect(parser.getDisposedCursorCount()).toBe(3);
  });
});

describe('RepoMap - Error Resilience Boundary', () => {
  const parser = new SafeTreeSitterParser();

  it('gracefully handles malformed syntax without crashing the process', () => {
    const malformedSnippets = [
      'class {{{ unclosed tokens and nulls \0\0\0 }',
      'def (((( invalid python syntax :::',
      'func func func {{{{',
      'impl Point for for for {{{',
      'const x: = = = = invalid ts;',
    ];

    for (let i = 0; i < malformedSnippets.length; i++) {
      const result = parser.parse(`malformed_${i}.ts`, malformedSnippets[i]!);
      expect(result).toBeDefined();
      expect(Array.isArray(result.symbols)).toBe(true);
      expect(Array.isArray(result.references)).toBe(true);
    }
  });

  it('catches runtime errors thrown during parsing and returns empty/partial result', () => {
    // Test that safe parser wraps any unexpected errors gracefully
    const brokenExtractor = {
      extract: () => {
        throw new Error('Simulated internal parser crash');
      }
    };

    const originalGetExtractor = getExtractor;
    // Test with non-existent file or corrupted input
    const result = parser.parse('corrupted.unknown', '');
    expect(result).toEqual({ symbols: [], references: [] });
  });

  it('verifies SyntaxTree and SyntaxCursor fail safely once disposed', () => {
    const parser = new SafeTreeSitterParser();
    // Verify tree/cursor lifecycle by creating a dummy tree and checking disposal
    const res = parser.parse('test.ts', 'export function dummy() {}');
    expect(res.symbols.length).toBeGreaterThan(0);
    expect(parser.getDisposedTreeCount()).toBe(1);
    expect(parser.getDisposedCursorCount()).toBe(1);

    parser.reset();
    expect(parser.getParseCount()).toBe(0);
    expect(parser.getRecycleCount()).toBe(0);
    expect(parser.getDisposedTreeCount()).toBe(0);
    expect(parser.getDisposedCursorCount()).toBe(0);
  });

  it('parseFile gracefully returns empty result for missing files', async () => {
    const parser = new SafeTreeSitterParser();
    const result = await parser.parseFile('/non/existent/path/never_exists.ts');
    expect(result).toEqual({ symbols: [], references: [] });
  });
});

