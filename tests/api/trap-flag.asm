; Minimal single-step guests: NASM -f bin -DMODE=16|32 -DCASE=N.
bits MODE
ORG 0x1000
%define COUNT 0x9000
%define LIMIT 0x9004
%define BP_COUNT 0x9008
%define UD_COUNT 0x900C
%define RECORDS 0x9100
%if MODE = 32
 %define FRAME ebp
 %define RETFLAGS 40
 %define RETSIZE dword
 %define RETURN iretd
%else
 %define FRAME bp
 %define RETFLAGS 36
 %define RETSIZE word
 %define RETURN iret
%endif
%macro ARM 0
 push RETSIZE 0x102
 popf
%endmacro

dd entry, db_handler, bp_handler, ud_handler, expected, (expected_end-expected)/4, irq_handler
%if CASE >= 23
 dd entry.bad
%else
 dd 0
%endif
entry:
%if CASE = 1
 ARM
 nop
.after: hlt
%elif CASE = 2
 ARM
 push RETSIZE 2
.pushed:
 popf
.cleared: hlt
%elif CASE = 3
 push RETSIZE 0x102
 %if MODE = 32
 push dword 8
%else
 push word 0
%endif
 push RETSIZE .target
 RETURN
.target: nop
.after: hlt
%elif CASE = 4 || CASE = 5 || CASE = 11 || CASE = 13
 mov ecx, 3
 mov esi, 0xA000
 mov edi, 0xA010
%if CASE = 11
 xor ecx, ecx
%endif
 mov al, 0x51
 mov dword [0xA000], 0x535251
 mov dword [0xA010], 0x535151
 ARM
.rep:
%if CASE = 5
 repe scasb
%elif CASE = 13
 repne scasb
%else
 rep movsb
%endif
.after: hlt
%elif CASE = 6
 %if MODE = 32
 mov eax, 16
%else
 xor eax, eax
%endif
 ARM
 mov ss, ax
 nop
.after: hlt
%elif CASE = 7
 push ss
 ARM
 pop ss
 nop
.after: hlt
%elif CASE = 8
 ARM
 sti
.after: nop
 hlt
%elif CASE = 9
 ARM
 int3
 hlt
%elif CASE = 10
 ARM
 ud2
 hlt
%elif CASE = 12
 %if MODE = 32
 mov eax, 16
%else
 xor eax, eax
%endif
 push RETSIZE 2
 ARM
 mov ss, ax
 popf
.after: hlt
%elif CASE = 14 || CASE = 17
 ; Host enters this already-cached NOP with TF set (snapshot/IRET equivalent).
 nop
.after: hlt
%elif CASE = 16
 ; Remap the master PIC, unmask only IRQ1, then raise it synchronously via OUT.
 mov al, 0x11
 out 0x20, al
 mov al, 0x20
 out 0x21, al
 mov al, 4
 out 0x21, al
 mov al, 1
 out 0x21, al
 mov al, 0xFD
 out 0x21, al
 mov dx, 0x2012
 push RETSIZE 0x302
 popf
 out dx, al
.after: hlt
%elif CASE = 18 || CASE = 19 || CASE = 20 || CASE = 21 || CASE = 22
%if CASE = 20
 ARM
%endif
%if CASE = 19
 db 0x65
%elif CASE = 22
 db 0x65, 0x67, 0x66
%endif
 db 0xF1
.after:
%if CASE = 21
 mov dword [0x9020], 1
.spin: jmp .spin
%else
 hlt
%endif
%elif CASE >= 23
 mov eax, 0x33
%if CASE = 32
 ARM
%elif CASE = 33
 jmp .bad
 times 0xFFE-($-$$) db 0x90
%endif
.bad:
%if CASE = 23
 db 0xF0, 0xF1
%elif CASE = 24
 db 0xF0, 0xCC
%elif CASE = 25
 db 0xF0, 0x65, 0xF1
%elif CASE = 26
 db 0xF0
 inc eax
%elif CASE = 27
 lock inc word [0xA000]
%elif CASE = 28
 db 0xF0
 add ax, [0xA000] ; memory source, not memory destination
%elif CASE = 29
 mov ebx, 1
 lock btc word [0xA000], bx
%elif CASE = 30
 db 0xF0
 cmp word [0xA000], 1
%elif CASE = 31
 db 0xF0
 bt word [0xA000], ax
%elif CASE = 32
%if MODE = 32
 a16 o16 lock add word [0xA000], 3
%else
 a32 o32 lock add dword [0xA000], 3
%endif
%elif CASE = 33
 db 0xF0, 0x65, 0xF1
%elif CASE = 34
 db 0xF0, 0xF0, 0xF1
%endif
.after: hlt
%elif CASE = 15
 ; Opposite operand-size POPF must preserve TF too.
%if MODE = 32
 push word 0x102
 popfw
%else
 push dword 0x102
 popfd
%endif
 db 0x66, 0x90
.after: hlt
%endif

expected:
%if CASE = 2
 dd entry.pushed, entry.cleared
%elif CASE = 4
 dd entry.rep, entry.rep, entry.after
%elif CASE = 5
 dd entry.rep, entry.rep, entry.after
%elif CASE = 13
 dd entry.after
%elif CASE = 9 || CASE = 10 || (CASE >= 23 && CASE != 32)
%else
 dd entry.after
%endif
expected_end:

db_handler:
 pushad
%if MODE = 32
 mov ebp, esp
%else
 mov bp, sp
%endif
 mov eax, [COUNT]
 imul edi, eax, 24
 add edi, RECORDS
%if MODE = 32
 mov edx, [FRAME+32]
%else
 movzx edx, word [FRAME+32]
%endif
 mov [edi], edx
%if MODE = 32
 mov edx, [FRAME+RETFLAGS]
%else
 movzx edx, word [FRAME+RETFLAGS]
%endif
 mov [edi+4], edx
%if CASE = 21
 xor edx, edx ; user-mode handler cannot read DR6
%else
 mov edx, dr6
%endif
 mov [edi+8], edx
 mov [edi+12], ecx
 pushf
%if MODE = 32
 pop edx
%else
 pop dx
 movzx edx, dx
%endif
 mov [edi+16], edx
 mov edx, [FRAME] ; saved EDI from PUSHAD
 mov [edi+20], edx
 inc eax
 mov [COUNT], eax
 cmp eax, [LIMIT]
 jb .keep
 and RETSIZE [FRAME+RETFLAGS], ~0x100
.keep:
 popad
 RETURN

bp_handler:
 pushad
%if MODE = 32
 mov ebp, esp
%else
 mov bp, sp
%endif
 inc dword [BP_COUNT]
 and RETSIZE [FRAME+RETFLAGS], ~0x100
 popad
 RETURN
ud_handler:
 pushad
%if MODE = 32
 mov ebp, esp
%else
 mov bp, sp
%endif
 inc dword [UD_COUNT]
%if CASE >= 23
%if MODE = 32
 mov eax, [FRAME+32]
%else
 movzx eax, word [FRAME+32]
%endif
 mov [0x9024], eax
 add RETSIZE [FRAME+32], entry.after-entry.bad
%else
 add RETSIZE [FRAME+32], 2
%endif
 and RETSIZE [FRAME+RETFLAGS], ~0x100
 popad
 RETURN

irq_handler:
 pushad
 inc dword [0x9010]
 mov eax, [COUNT]
 mov [0x9014], eax
 mov al, 0x20
 out 0x20, al
 popad
 RETURN
